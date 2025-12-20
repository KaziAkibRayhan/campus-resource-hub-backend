// backend/middleware/upload.js
const multer = require("multer");
const path = require("path");
const cloudinary = require("../config/cloudinary");
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// Allowed file types
const allowedMimeTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // DOCX
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // PPTX
  "application/vnd.ms-powerpoint", // PPT
  "application/msword", // DOC
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // XLSX
];

// File filter
const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only PDF, DOCX, PPTX, and XLSX files are allowed."
      ),
      false
    );
  }
};

// Configure Cloudinary Storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "campus-resources",
    allowed_formats: ["pdf", "docx", "pptx", "xlsx", "doc", "ppt"],
    resource_type: "raw", // Important for non-image files
  },
});

// Multer upload configuration
const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 20 * 1024 * 1024, // 20MB default
  },
  fileFilter: fileFilter,
});

// Error handling middleware
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "File size too large. Maximum size is 20MB.",
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  } else if (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
  next();
};

module.exports = { upload, handleUploadError };
