const express = require("express");
const app = express();
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();
const multer = require("multer");
const QRCode = require("qrcode");
const archiver = require("archiver");

// This is what gets baked into every certificate's QR code, so it MUST be
// a URL your phone (on any network) can actually reach — not localhost.
// Set FRONTEND_URL in your .env to wherever verify.html is really hosted.
// Falls back to your live Vercel frontend if the env var isn't set.
const FRONTEND_URL = process.env.FRONTEND_URL || "https://updated-certificate.vercel.app";
app.use("/uploads", express.static("uploads"));
app.use("/generated-certificates", express.static("generated-certificates"));

// Forces a real browser download (Content-Disposition: attachment) instead
// of just opening the PDF inline. The plain /generated-certificates static
// route above can't do this reliably for cross-origin requests (frontend on
// one domain, backend on another) because the HTML `download` attribute is
// ignored by browsers for cross-origin links.
app.get("/download-certificate/:filename", (req, res) => {
  const filePath = path.join(
    __dirname,
    "generated-certificates",
    req.params.filename,
  );

  res.download(filePath, (err) => {
    if (err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(404).json({ success: false, message: "File not found" });
      }
    }
  });
});

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 10,
});

// Prevent an idle-client network error (e.g. Neon auto-suspend / cold start)
// from crashing the whole server.
pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err.message);
});

// Wrap pool.query so every existing call site automatically gets a retry
// on transient connection drops (common right after Neon wakes from
// auto-suspend), without having to change every query in this file.
const rawPoolQuery = pool.query.bind(pool);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "57P01", // admin_shutdown
]);

pool.query = async (text, params) => {
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await rawPoolQuery(text, params);
    } catch (err) {
      lastErr = err;
      const isTransient =
        TRANSIENT_ERROR_CODES.has(err.code) ||
        TRANSIENT_ERROR_CODES.has(err.message);

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      console.warn(
        `DB query failed (${err.code || err.message}), retrying attempt ${attempt + 1}/${maxAttempts}...`,
      );
      // small backoff so a still-waking Neon compute has time to come up
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  throw lastErr;
};

app.use(express.json());
app.use(cors());

const fs = require("fs");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const path = require("path");

// ---------------------------------------------------------------------------
// Dynamic text-layout helpers
//
// These replace the old "hardcoded x / fixed font size" approach for the
// student name (and anything centered underneath it) with real text
// measurement, so the name is always centered and always sized to fit,
// no matter how short or long it is.
// ---------------------------------------------------------------------------

// Optional custom certificate fonts. If real font files are dropped into
// backend/fonts/ (see names below), they are embedded and used everywhere
// the "name font" / "body font" is requested. If the files aren't present,
// we fall back to pdf-lib's built-in Helvetica family so the app keeps
// working out of the box. This is what makes embedFont() below always
// resolve to a fully-loaded font *before* any measuring/drawing happens —
// there is no async font swap between preview and download because both
// come from the exact same generated PDF.
// Matches the dark navy used by the template's own headings ("CERTIFICATE
// OF COMPLETION", etc.) so the name reads as part of the original design
// instead of plain default-black text pasted on top.
const NAME_COLOR = rgb(0.08, 0.11, 0.2);

const CUSTOM_FONT_FILES = {
  nameBold: path.join(__dirname, "fonts", "CertificateName-Bold.ttf"),
  bodyRegular: path.join(__dirname, "fonts", "CertificateBody-Regular.ttf"),
};

// Loads (and embeds) the fonts used across the whole certificate. Returns
// { nameFont, bodyFont }. Called once per PDF, right after the document is
// created and before anything is measured or drawn, so every measurement
// (widthOfTextAtSize) and every drawText call uses the exact same, fully
// loaded font metrics.
async function loadCertificateFonts(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);

  let nameFont;
  let bodyFont;

  try {
    const bytes = fs.readFileSync(CUSTOM_FONT_FILES.nameBold);
    nameFont = await pdfDoc.embedFont(bytes, { subset: true });
  } catch (err) {
    // No custom font shipped yet — fall back to a bold standard font so the
    // name still reads as visually distinct from the body text.
    nameFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  try {
    const bytes = fs.readFileSync(CUSTOM_FONT_FILES.bodyRegular);
    bodyFont = await pdfDoc.embedFont(bytes, { subset: true });
  } catch (err) {
    bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  return { nameFont, bodyFont };
}

// Shrink-to-fit: returns the largest font size (in `size` steps) between
// minSize and maxSize at which `text` is no wider than `maxWidth`, using
// real glyph measurement (font.widthOfTextAtSize) rather than a guess.
function fitTextToWidth(font, text, { maxWidth, maxSize, minSize = 12, step = 0.5 }) {
  let size = maxSize;

  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size = Math.max(minSize, size - step);
  }

  return size;
}

// Returns the x position that horizontally centers `text` (at `size`)
// around `centerX`, based on its actual measured width.
function calculateTextPosition(font, text, size, centerX) {
  const width = font.widthOfTextAtSize(text, size);
  return { x: centerX - width / 2, width };
}

// Draws `text` centered around `centerX`, auto-shrinking it to fit inside
// maxWidth first. This is the single source of truth for both the student
// name and any other line that needs to stay centered regardless of its
// content length (e.g. the fixed sentence beneath it).
function drawAutoFitCenteredText(page, font, text, {
  centerX,
  y,
  maxWidth,
  maxSize,
  minSize = 12,
  color,
}) {
  const size = fitTextToWidth(font, text, { maxWidth, maxSize, minSize });
  const { x, width } = calculateTextPosition(font, text, size, centerX);

  page.drawText(text, { x, y, size, font, color });

  return { size, width, x, y };
}

// The student name is always drawn centered and auto-sized via
// drawAutoFitCenteredText(). This thin wrapper just documents the call site
// and keeps the (centerX/maxWidth/maxSize/minSize) contract in one place.
function drawStudentName(page, nameFont, recipientName, { centerX, y, maxWidth, maxSize, minSize, color }) {
  return drawAutoFitCenteredText(page, nameFont, recipientName, {
    centerX,
    y,
    maxWidth,
    maxSize,
    minSize,
    color,
  });
}

// Calculates the vertical gap between the student name's baseline and the
// line directly beneath it, as a function of the *actual* font size the
// name ended up using (from drawStudentName's return value) rather than a
// fixed pixel gap. `ratio` is the line-height multiplier that reproduces
// the certificate's original, designed spacing when the name is drawn at
// its maximum size — so normal-length names look exactly like the original
// design, and only long names (which shrink) get a proportionally tighter,
// still-natural gap instead of a leftover empty gap.
function calculateVerticalSpacing(nameSize, ratio = 1.3) {
  return nameSize * ratio;
}

function wrapText(text, maxWidth, font, fontSize) {
  const words = text.split(" ");

  let lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine === "" ? word : currentLine + " " + word;

    const width = font.widthOfTextAtSize(testLine, fontSize);

    if (width <= maxWidth) {
      currentLine = testLine;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  lines.push(currentLine);

  return lines;
}

// Draws "<Label> <value>" as one real text line (label + value share the
// same font/baseline) instead of relying on the label being baked into the
// template image. x/y is where the label starts.
function drawLabeledLine(page, font, label, value, { x, y, size = 17, color } = {}) {
  page.drawText(label, { x, y, size, font, color });
  const labelWidth = font.widthOfTextAtSize(label, size);
  page.drawText(value, { x: x + labelWidth, y, size, font, color });
}

// Draws "<prefix><value><suffix>" as one continuous text line, auto-shrinking
// the value if it's long, and centering the WHOLE sentence around centerX
// (not just the value) instead of relying on prefix/suffix being baked into
// the template image.
function drawCompletionLine(
  page,
  font,
  value,
  { y, centerX, prefix, suffix, maxValueWidth = 200, baseSize = 17, color } = {},
) {
  let fontSize = baseSize;
  while (
    font.widthOfTextAtSize(value, fontSize) > maxValueWidth &&
    fontSize > 10
  ) {
    fontSize--;
  }

  const prefixWidth = font.widthOfTextAtSize(prefix, fontSize);
  const valueWidth = font.widthOfTextAtSize(value, fontSize);
  const suffixWidth = font.widthOfTextAtSize(suffix, fontSize);
  const totalWidth = prefixWidth + valueWidth + suffixWidth;

  let x = centerX - totalWidth / 2;

  page.drawText(prefix, { x, y, size: fontSize, font, color });
  x += prefixWidth;
  page.drawText(value, { x, y, size: fontSize, font, color });
  x += valueWidth;
  page.drawText(suffix, { x, y, size: fontSize, font, color });

  return fontSize;
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

app.get("/certificates", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM certificates");

    res.json(result.rows);
  } catch (err) {
    console.log(err);
    res.status(500).json({
      message: "Server error",
    });
  }
});

app.get("/certificate/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const result = await pool.query(
      "SELECT * FROM certificates WHERE certificate_id=$1",
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Certificate Not Found",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.log(err);
    res.status(500).json({
      message: "Server Error",
    });
  }
});

app.put("/certificate/:id", upload.single("certificate"), async (req, res) => {
  const id = req.params.id;
  try {
    const result = await pool.query(
      "UPDATE certificates SET file_url=$1 WHERE certificate_id=$2 RETURNING *",
      [req.file.path, id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Certificate not found",
      });
    }

    res.json({
      message: "Certificate updated successfully",
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
});
app.post("/addCertificate", upload.single("certificate"), async (req, res) => {
  try {
    
    const certificateId = req.body.certificateId;

    const filePath = req.file.path;

    await pool.query(
      `INSERT INTO certificates
         (certificate_id, file_url)
         VALUES ($1,$2)`,
      [certificateId, filePath],
    );

    res.json({
      message: "Certificate added successfully",
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
});

app.delete("/certificate/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const result = await pool.query(
      `DELETE FROM certificates
             WHERE certificate_id = $1
             RETURNING *`,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Certificate not found",
      });
    }

    res.json({
      message: "Certificate deleted successfully",
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
});
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

app.post("/adminLogin", (req, res) => {
  const password = req.body.password;

  if (password === process.env.ADMIN_PASSWORD) {
    return res.json({
      success: true,
    });
  }

  return res.json({
    success: false,
  });
});

const signMap = {
  CMO: {
    image: "Sukumar_Sir.png",
    lines: ["Mr. Sukumar G", "CMO, Robomanthan"],
  },
};

const LOGO = {
  x: 700,
  y: 470,
  width: 90,
  height: 90,
};

// Builds a single certificate PDF and persists it (DB row + file on disk).
// `fields` is the same shape as req.body for /generateCertificate.
// `logoFile` is the same shape as req.file (multer) — pass null if none.
// Returns { pdfBytes, pdfFileName, certificateId } instead of sending a response,
// so it can be reused by both the single-certificate route and the bulk route.
async function buildCertificatePdf(fields, logoFile) {
      const {
        certificateId,
        recipientName,
        collegeName,
        programName,
        role,
        department,
        startDate,
        endDate,
        issueDate,
        certificateType,
        customDescription,
        useCustomDescription,
        includeAuthorizedSign,
        secondSignatory,
        includeSecondSign,
        otherSignatoryName,
        otherSignatoryDesignation,
        includeThirdSign,
        thirdSignatoryName,
        thirdSignatoryDesignation,
        includeFourthSign,
        fourthSignatoryName,
        fourthSignatoryDesignation,
      } = fields;

      

      const defaultDescriptions = {
        course:
          "The learner successfully completed the course requirements and demonstrated commitment, technical understanding, practical skills, and continuous learning throughout the program.",

        hackathon:
          "The participant demonstrated innovation, creativity, teamwork, problem-solving ability, technical expertise, and dedication throughout the hackathon event.",

        workshop:
          "The attendee engaged actively throughout the workshop, gaining hands-on exposure and practical knowledge of the subject under expert guidance.",
      };

      let descriptionText = "";

      if (certificateType === "course" || certificateType === "hackathon" || certificateType === "workshop") {
        if (useCustomDescription === "yes" && customDescription.trim() !== "") {
          descriptionText = customDescription;
        } else {
          descriptionText = defaultDescriptions[certificateType];
        }
      }

      

      await pool.query(
        `
    INSERT INTO certificates
    (
      certificate_id,
      recipient_name,
      college_name,
      program_name,
      role,
      department,
      start_date,
      end_date,
      issue_date,
      certificate_type
    )
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
        [
          certificateId,
          recipientName,
          collegeName,
          programName,
          role,
          department,
          startDate,
          endDate,
          issueDate,
          certificateType,
        ],
      );
      
      const pdfDoc = await PDFDocument.create();

      // Load + embed fonts up front, before anything is measured or drawn.
      // nameFont is the bold face used only for the student name; bodyFont
      // is the regular face used for every other piece of body text (same
      // font the rest of the template already used).
      const { nameFont, bodyFont } = await loadCertificateFonts(pdfDoc);

      let organizationLogoImage = null;

      if (logoFile) {
        const logoBytes = fs.readFileSync(logoFile.path);

        if (logoFile.mimetype === "image/png") {
          organizationLogoImage = await pdfDoc.embedPng(logoBytes);
        } else {
          organizationLogoImage = await pdfDoc.embedJpg(logoBytes);
        }
      }

      // `font` keeps its original name so every existing call site below
      // (drawLabeledLine, drawCompletionLine, wrapText, etc.) keeps working
      // unchanged — it's now just sourced from loadCertificateFonts().
      const font = bodyFont;
      const page = pdfDoc.addPage([842, 595]);
      const totalSigns =
        2 +
        (includeThirdSign === "yes" ? 1 : 0) +
        (includeFourthSign === "yes" ? 1 : 0);

      let templateFile;

      if (certificateType === "internship") {
        if (totalSigns === 2) templateFile = "2intern.png";
        else if (totalSigns === 3) templateFile = "intern3.png";
        else templateFile = "intern4.png";
      } else if (certificateType === "course") {
        if (totalSigns === 2) templateFile = "2course.png";
        else if (totalSigns === 3) templateFile = "course3.png";
        else templateFile = "course4.png";
      } else if (certificateType === "hackathon") {
        if (totalSigns === 2) templateFile = "2hack.png";
        else if (totalSigns === 3) templateFile = "hack3.png";
        else templateFile = "hack4.png";
      } else if (certificateType === "workshop") {
        if (totalSigns === 2) templateFile = "2workshop.png";
        else if (totalSigns === 3) templateFile = "workshop3.png";
        else templateFile = "workshop4.png";
      } else if (certificateType === "fulltime") {
        if (totalSigns === 2) templateFile = "2exp.png";
        else if (totalSigns === 3) templateFile = "exp3.png";
        else templateFile = "exp4.png";
      }

      let secondSignLines = [];
      if (secondSignatory === "CMO") {
        secondSignLines = signMap.CMO.lines;
      } else {
        secondSignLines = [otherSignatoryName, otherSignatoryDesignation];
      }

      

      const imageBytes = fs.readFileSync(
        path.join(__dirname, "templates", templateFile),
      );

      const image = await pdfDoc.embedPng(imageBytes);

      page.drawImage(image, {
        x: 0,
        y: 0,
        width: 842,
        height: 595,
      });

      

      if (organizationLogoImage) {
        

        page.drawImage(organizationLogoImage, LOGO);
      }

      
      const verifyUrl = `${FRONTEND_URL}/verify.html?id=${certificateId}`;

      const qrImageBytes = await QRCode.toBuffer(verifyUrl);

      const qrImage = await pdfDoc.embedPng(qrImageBytes);

      let authorizedSignImage;

      if (includeAuthorizedSign === "yes") {
        const signBytes = fs.readFileSync(
          path.join(__dirname, "signatures", "Saurav_Sir.png"),
        );
        
        authorizedSignImage = await pdfDoc.embedPng(signBytes);
      }

      let secondSignImage;

      if (secondSignatory === "CMO" && includeSecondSign === "yes") {
        const signBytes = fs.readFileSync(
          path.join(__dirname, "signatures", signMap.CMO.image),
        );
        
        secondSignImage = await pdfDoc.embedPng(signBytes);
      }

      if (certificateType === "internship") {
        if (totalSigns>=3) {
          //
          const centerX = 421; // half of 842 page width

          // Name: always centered, auto-sized to fit, using real glyph
          // measurement instead of a fixed x/size.
          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 360,
            maxWidth: 560,
            maxSize: 35,
            minSize: 20,
            color: NAME_COLOR,
          });

          // Gap to the line below scales with the name's actual size, so
          // there's no leftover empty space when a long name shrinks.
          const studentOfY = 360 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Student of ${collegeName}`, {
            centerX,
            y: studentOfY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          // Auto center + auto shrink, whole sentence drawn as real text
          drawCompletionLine(page, font, programName, {
            y: 293,
            centerX: centerX + 20,
            prefix: "has successfully completed the ",
            suffix: " at Robomanthan.",
            maxValueWidth: 200,
            baseSize: 17,
          });

          page.drawText(startDate, {
            x: 370,
            y: 252,
            size: 14,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 252,
            size: 14,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 140,
            y: 259,
            size: 13,
          });

          page.drawText(issueDate, {
            x: 140,
            y: 227,
            size: 13,
          });

          page.drawText(department, {
            x: 140,
            y: 198,
            size: 13,
          });

          page.drawText(role, {
            x: 140,
            y: 173,
            size: 13,
          });
          page.drawImage(qrImage, {
            x: 705,
            y: 320,
            width: 90,
            height: 90,
          });
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 78,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 66,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 100,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 78,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 66,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 100,
              width: 90,
              height: 40,
            });
          }
          if (includeThirdSign === "yes") {
            page.drawText(thirdSignatoryName, {
              x: 70,
              y: 78,
              size: 11,
            });
            page.drawText(thirdSignatoryDesignation, {
              x: 70,
              y: 66,
              size: 11,
            });
          }
          if (includeFourthSign === "yes") {
            page.drawText(fourthSignatoryName, {
              x: 630,
              y: 78,
              size: 11,
            });
            page.drawText(fourthSignatoryDesignation, {
              x: 630,
              y: 66,
              size: 11,
            });
          }
        } else {
          const centerX2 = 421; // half of 842 page width

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX: centerX2,
            y: 360,
            maxWidth: 560,
            maxSize: 35,
            minSize: 20,
            color: NAME_COLOR,
          });

          const studentOfY2 = 360 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Student of ${collegeName}`, {
            centerX: centerX2,
            y: studentOfY2,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          // Auto center + auto shrink, whole sentence drawn as real text
          drawCompletionLine(page, font, programName, {
            y: 293,
            centerX: centerX2 + 20,
            prefix: "has successfully completed the ",
            suffix: " at Robomanthan.",
            maxValueWidth: 200,
            baseSize: 17,
          });

          page.drawText(startDate, {
            x: 370,
            y: 252,
            size: 14,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 252,
            size: 14,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 170,
            y: 172,
            size: 13,
          });

          page.drawText(issueDate, {
            x: 170,
            y: 145,
            size: 13,
          });

          page.drawText(department, {
            x: 170,
            y: 119,
            size: 13,
          });

          page.drawText(role, {
            x: 170,
            y: 93,
            size: 13,
          });
          page.drawImage(qrImage, {
            x: 670,
            y: 95,
            width: 90,
            height: 90,
          });
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 78,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 66,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 100,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 78,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 66,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 100,
              width: 90,
              height: 40,
            });
          }
        }
      } else if (certificateType === "course") {
        // COURSE COORDINATES HERE
        if (totalSigns>=3) {
          //
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const learnerFromY = 370 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Learner from ${collegeName}`, {
            centerX,
            y: learnerFromY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          drawCompletionLine(page, font, programName, {
            y: 300,
            centerX,
            prefix: "has successfully completed the ",
            suffix: " at Robomanthan.",
            maxValueWidth: 220,
            baseSize: 16,
          });

          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 160,
            y: 267,
            size: 12,
          });

          page.drawText(issueDate, {
            x: 160,
            y: 235,
            size: 12,
          });

          page.drawText(department, {
            x: 160,
            y: 205,
            size: 12,
          });

          page.drawText(role, {
            x: 160,
            y: 175,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 700,
            y: 320,
            width: 90,
            height: 90,
          });
          const lines = wrapText(
            descriptionText,
            460, // max width
            font,
            12,
          );

          let currentY = 230;

          for (const line of lines) {
            page.drawText(line, {
              x: 240,
              y: currentY,
              size: 12,
              font,
            });

            currentY -= 18;
          }
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          if (includeThirdSign === "yes") {
            page.drawText(thirdSignatoryName, {
              x: 70,
              y: 98,
              size: 11,
            });
            page.drawText(thirdSignatoryDesignation, {
              x: 70,
              y: 86,
              size: 11,
            });
          }
          if (includeFourthSign === "yes") {
            page.drawText(fourthSignatoryName, {
              x: 630,
              y: 98,
              size: 11,
            });
            page.drawText(fourthSignatoryDesignation, {
              x: 630,
              y: 86,
              size: 11,
            });
          }
        } else {
          //name
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const learnerFromY = 370 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Learner from ${collegeName}`, {
            centerX,
            y: learnerFromY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          drawCompletionLine(page, font, programName, {
            y: 300,
            centerX,
            prefix: "has successfully completed the ",
            suffix: " at Robomanthan.",
            maxValueWidth: 220,
            baseSize: 16,
          });

          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 180,
            y: 175,
            size: 12,
          });

          page.drawText(issueDate, {
            x: 180,
            y: 149,
            size: 12,
          });

          page.drawText(department, {
            x: 180,
            y: 124,
            size: 12,
          });

          page.drawText(role, {
            x: 180,
            y: 99,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 665,
            y: 100,
            width: 90,
            height: 90,
          });
          const lines = wrapText(
            descriptionText,
            500, // max width
            font,
            12,
          );

          let currentY = 230;

          for (const line of lines) {
            page.drawText(line, {
              x: 190,
              y: currentY,
              size: 12,
              font,
            });

            currentY -= 18;
          }
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
        }
      } else if (certificateType === "hackathon") {
        // HACKATHON COORDINATES HERE
        if (totalSigns>=3) {
          //
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const participantFromY = 370 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Participant from ${collegeName}`, {
            centerX,
            y: participantFromY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          drawCompletionLine(page, font, programName, {
            y: 300,
            centerX,
            prefix: "has successfully participated in ",
            suffix: " at Robomanthan.",
            maxValueWidth: 220,
            baseSize: 16,
          });

          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 140,
            y: 270,
            size: 12,
          });

          page.drawText(issueDate, {
            x: 140,
            y: 243,
            size: 12,
          });

          page.drawText(department, {
            x: 140,
            y: 220,
            size: 12,
          });

          page.drawText(role, {
            x: 140,
            y: 192,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 700,
            y: 320,
            width: 90,
            height: 90,
          });
          const lines = wrapText(
            descriptionText,
            460, // max width
            font,
            12,
          );

          let currentY = 230;

          for (const line of lines) {
            page.drawText(line, {
              x: 220,
              y: currentY,
              size: 12,
              font,
            });

            currentY -= 18;
          }
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          if (includeThirdSign === "yes") {
            page.drawText(thirdSignatoryName, {
              x: 70,
              y: 98,
              size: 11,
            });
            page.drawText(thirdSignatoryDesignation, {
              x: 70,
              y: 86,
              size: 11,
            });
          }
          if (includeFourthSign === "yes") {
            page.drawText(fourthSignatoryName, {
              x: 630,
              y: 98,
              size: 11,
            });
            page.drawText(fourthSignatoryDesignation, {
              x: 630,
              y: 86,
              size: 11,
            });
          }
        } else {
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const participantFromY = 370 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Participant from ${collegeName}`, {
            centerX,
            y: participantFromY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          drawCompletionLine(page, font, programName, {
            y: 300,
            centerX,
            prefix: "has successfully participated in ",
            suffix: " at Robomanthan.",
            maxValueWidth: 220,
            baseSize: 16,
          });

          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 180,
            y: 175,
            size: 12,
          });

          page.drawText(issueDate, {
            x: 180,
            y: 149,
            size: 12,
          });

          page.drawText(department, {
            x: 180,
            y: 124,
            size: 12,
          });

          page.drawText(role, {
            x: 180,
            y: 99,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 665,
            y: 100,
            width: 90,
            height: 90,
          });
          const lines = wrapText(
            descriptionText,
            500, // max width
            font,
            12,
          );

          let currentY = 230;

          for (const line of lines) {
            page.drawText(line, {
              x: 190,
              y: currentY,
              size: 12,
              font,
            });

            currentY -= 18;
          }
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
        }
      } else if (certificateType === "workshop") {
        // WORKSHOP COORDINATES HERE
        if (totalSigns>=3) {
          //
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const attendeeOfY = 370 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Attendee of ${collegeName}`, {
            centerX,
            y: attendeeOfY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          drawCompletionLine(page, font, programName, {
            y: 300,
            centerX,
            prefix: "has successfully attended the ",
            suffix: " workshop at Robomanthan.",
            maxValueWidth: 220,
            baseSize: 16,
          });

          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 140,
            y: 270,
            size: 12,
          });

          page.drawText(issueDate, {
            x: 140,
            y: 243,
            size: 12,
          });

          page.drawText(department, {
            x: 140,
            y: 220,
            size: 12,
          });

          page.drawText(role, {
            x: 140,
            y: 192,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 700,
            y: 320,
            width: 90,
            height: 90,
          });
          const lines = wrapText(
            descriptionText,
            460, // max width
            font,
            12,
          );

          let currentY = 230;

          for (const line of lines) {
            page.drawText(line, {
              x: 220,
              y: currentY,
              size: 12,
              font,
            });

            currentY -= 18;
          }
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          if (includeThirdSign === "yes") {
            page.drawText(thirdSignatoryName, {
              x: 70,
              y: 98,
              size: 11,
            });
            page.drawText(thirdSignatoryDesignation, {
              x: 70,
              y: 86,
              size: 11,
            });
          }
          if (includeFourthSign === "yes") {
            page.drawText(fourthSignatoryName, {
              x: 630,
              y: 98,
              size: 11,
            });
            page.drawText(fourthSignatoryDesignation, {
              x: 630,
              y: 86,
              size: 11,
            });
          }
        } else {
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const attendeeOfY = 370 - calculateVerticalSpacing(nameLayout.size);

          drawAutoFitCenteredText(page, font, `Attendee of ${collegeName}`, {
            centerX,
            y: attendeeOfY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          drawCompletionLine(page, font, programName, {
            y: 300,
            centerX,
            prefix: "has successfully attended the ",
            suffix: " workshop at Robomanthan.",
            maxValueWidth: 220,
            baseSize: 16,
          });

          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(certificateId, {
            x: 180,
            y: 175,
            size: 12,
          });

          page.drawText(issueDate, {
            x: 180,
            y: 149,
            size: 12,
          });

          page.drawText(department, {
            x: 180,
            y: 124,
            size: 12,
          });

          page.drawText(role, {
            x: 180,
            y: 99,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 665,
            y: 100,
            width: 90,
            height: 90,
          });
          const lines = wrapText(
            descriptionText,
            500, // max width
            font,
            12,
          );

          let currentY = 230;

          for (const line of lines) {
            page.drawText(line, {
              x: 190,
              y: currentY,
              size: 12,
              font,
            });

            currentY -= 18;
          }
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
        }
      } else if (certificateType === "fulltime") {
        if (totalSigns>=3) {
          //
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const workedAsY = 370 - calculateVerticalSpacing(nameLayout.size);

          // Designation (Worked as)
          drawAutoFitCenteredText(page, font, `Worked as ${collegeName}`, {
            centerX,
            y: workedAsY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          // REMOVE programName from center completely

          // Duration
          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          // Left panel

          // Certificate ID
          page.drawText(certificateId, {
            x: 150,
            y: 275,
            size: 12,
          });

          // Issue Date
          page.drawText(issueDate, {
            x: 150,
            y: 249,
            size: 12,
          });

          // Department
          page.drawText(role, {
            x: 150,
            y: 220,
            size: 12,
          });

          // Employee ID
          page.drawText(programName, {
            x: 150,
            y: 195,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 700,
            y: 320,
            width: 90,
            height: 90,
          });
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          if (includeThirdSign === "yes") {
            page.drawText(thirdSignatoryName, {
              x: 70,
              y: 98,
              size: 11,
            });
            page.drawText(thirdSignatoryDesignation, {
              x: 70,
              y: 86,
              size: 11,
            });
          }
          if (includeFourthSign === "yes") {
            page.drawText(fourthSignatoryName, {
              x: 630,
              y: 98,
              size: 11,
            });
            page.drawText(fourthSignatoryDesignation, {
              x: 630,
              y: 86,
              size: 11,
            });
          }
        } else {
          // Employee Name
          const centerX = 421;

          const nameLayout = drawStudentName(page, nameFont, recipientName, {
            centerX,
            y: 370,
            maxWidth: 560,
            maxSize: 33,
            minSize: 20,
            color: NAME_COLOR,
          });

          const workedAsY = 370 - calculateVerticalSpacing(nameLayout.size);

          // Designation (Worked as)
          drawAutoFitCenteredText(page, font, `Worked as ${collegeName}`, {
            centerX,
            y: workedAsY,
            maxWidth: 560,
            maxSize: 17,
            minSize: 12,
          });

          // REMOVE programName from center completely

          // Duration
          page.drawText(startDate, {
            x: 380,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          page.drawText(endDate, {
            x: 480,
            y: 260,
            size: 13,
            color: rgb(1, 1, 1),
          });

          // Left panel

          // Certificate ID
          page.drawText(certificateId, {
            x: 180,
            y: 175,
            size: 12,
          });

          // Issue Date
          page.drawText(issueDate, {
            x: 180,
            y: 149,
            size: 12,
          });

          // Department
          page.drawText(role, {
            x: 180,
            y: 124,
            size: 12,
          });

          // Employee ID
          page.drawText(programName, {
            x: 180,
            y: 99,
            size: 12,
          });

          page.drawImage(qrImage, {
            x: 665,
            y: 100,
            width: 90,
            height: 90,
          });
          //Name of first signatory
          page.drawText("Mr. Saurav Kumar", {
            x: 280,
            y: 98,
            size: 11,
          });
          //designation of first signatory
          page.drawText("CEO,Robomanthan", {
            x: 280,
            y: 86,
            size: 11,
          });
          if (authorizedSignImage) {
            page.drawImage(authorizedSignImage, {
              x: 275,
              y: 120,
              width: 90,
              height: 40,
            });
          }
          // Name of second signatory
          page.drawText(secondSignLines[0], {
            x: 470, // adjust
            y: 98,
            size: 11,
          });

          // Designation of second signatory
          page.drawText(secondSignLines[1], {
            x: 470, // same x
            y: 86,
            size: 11,
          });
          //signature image of second signatory
          if (secondSignImage) {
            page.drawImage(secondSignImage, {
              x: 465,
              y: 120,
              width: 90,
              height: 40,
            });
          }
        }
      }

      const pdfBytes = await pdfDoc.save();

      const pdfFileName = `${certificateId}.pdf`;

      const pdfPath = path.join(
        __dirname,
        "generated-certificates",
        pdfFileName,
      );

      fs.writeFileSync(pdfPath, pdfBytes);
      
      await pool.query(
        `
  UPDATE certificates
  SET file_url = $1
  WHERE certificate_id = $2
  `,
        [`generated-certificates/${pdfFileName}`, certificateId],
      );

      return { pdfBytes, pdfFileName, certificateId };
}

// Single-certificate route — unchanged behaviour, now just a thin wrapper
// around buildCertificatePdf().
app.post(
  "/generateCertificate",
  upload.single("organizationLogo"),
  async (req, res) => {
    try {
      const result = await buildCertificatePdf(req.body, req.file);

      res.json({
        success: true,
        message: "Certificate generated successfully",
        pdf: result.pdfFileName,
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        success: false,
        message: err.message,
      });
    }
  },
);

// Bundle / bulk route — same fields as /generateCertificate, but
// `certificateId` and `recipientName` are supplied per-student via a
// "students" field: a JSON string like
// [{ "certificateId": "RM001", "recipientName": "Asha Rao" }, ...]
// Everything else (certificateType, dates, signatories, logo, etc.) is
// shared across every certificate in the batch. Streams back a .zip.
app.post(
  "/generateBulkCertificates",
  upload.single("organizationLogo"),
  async (req, res) => {
    let students;

    try {
      students = JSON.parse(req.body.students || "[]");
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: "Invalid students list — could not parse JSON.",
      });
    }

    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide at least one student (name + certificate ID).",
      });
    }

    if (students.length > 200) {
      return res.status(400).json({
        success: false,
        message: "Please generate at most 200 certificates per bundle.",
      });
    }

    try {
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="certificates_bundle_${Date.now()}.zip"`,
      );

      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("error", (err) => {
        throw err;
      });

      archive.pipe(res);

      const failed = [];

      for (const student of students) {
        const certificateId = (student.certificateId || "").trim();
        const recipientName = (student.recipientName || "").trim();

        if (!certificateId || !recipientName) {
          failed.push(`(missing name or RM id) — skipped`);
          continue;
        }

        try {
          const fields = {
            ...req.body,
            certificateId,
            recipientName,
          };

          const result = await buildCertificatePdf(fields, req.file);

          archive.append(Buffer.from(result.pdfBytes), {
            name: `${result.certificateId}.pdf`,
          });
        } catch (err) {
          console.error(`Bulk generation failed for ${certificateId}:`, err);
          failed.push(`${certificateId} - ${recipientName}: ${err.message}`);
        }
      }

      if (failed.length > 0) {
        archive.append(failed.join("\n"), { name: "failed_certificates.txt" });
      }

      await archive.finalize();
    } catch (err) {
      console.error(err);

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: err.message,
        });
      } else {
        res.end();
      }
    }
  },
);

app.get("/test-pdf", async (req, res) => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([842, 595]);
  page.drawText("HELLO ROBOMANTHAN", {
    x: 200,
    y: 300,
    size: 30,
  });
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync("./generated-certificates/test.pdf", pdfBytes);
  res.json({
    success: true,
  });
});

app.get("/test-template", async (req, res) => {
  try {
    const pdfDoc = await PDFDocument.create();

    const page = pdfDoc.addPage([842, 595]);

    const imageBytes = fs.readFileSync(
      path.join(__dirname, "templates", "final_internship_template.png"),
    );

    const image = await pdfDoc.embedPng(imageBytes);

    page.drawImage(image, {
      x: 0,
      y: 0,
      width: 842,
      height: 595,
    });

    const pdfBytes = await pdfDoc.save();

    fs.writeFileSync(
      path.join(__dirname, "generated-certificates", "template-test.pdf"),
      pdfBytes,
    );

    res.json({
      success: true,
      message: "Template PDF created",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});