// backend/middleware/upload.js
const multer = require("multer");
const path = require("path");
const cloudinary = require("../config/cloudinary");
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// Allowed file types for chat attachments
const allowedMimeTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // DOCX
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // PPTX
  "application/vnd.ms-powerpoint", // PPT
  "application/msword", // DOC
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // XLSX
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
];

// File size limits by type
const fileSizeLimits = {
  "image/jpeg": 10 * 1024 * 1024, // 10MB for images
  "image/jpg": 10 * 1024 * 1024,
  "image/png": 10 * 1024 * 1024,
  "image/webp": 10 * 1024 * 1024,
  "image/gif": 10 * 1024 * 1024,
  "image/avif": 10 * 1024 * 1024,
  "image/svg+xml": 5 * 1024 * 1024,
  "application/pdf": 25 * 1024 * 1024, // 25MB for PDFs
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 25 * 1024 * 1024, // 25MB for DOCX
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": 25 * 1024 * 1024, // 25MB for PPTX
  "application/vnd.ms-powerpoint": 25 * 1024 * 1024,
  "application/msword": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 25 * 1024 * 1024,
  "text/plain": 5 * 1024 * 1024, // 5MB for text files
  "application/zip": 50 * 1024 * 1024, // 50MB for zip files
  "application/x-zip-compressed": 50 * 1024 * 1024,
};

// File filter with enhanced security checks
const fileFilter = (req, file, cb) => {
  // Check if file type is allowed
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(
      new Error(
        "Invalid file type. Allowed types: PDF, DOC, DOCX, PPT, PPTX, XLSX, Images (JPG, PNG, WEBP, GIF, AVIF, SVG), Text, and ZIP files."
      ),
      false
    );
  }

  // Check file extension matches MIME type
  const ext = path.extname(file.originalname).toLowerCase();
  const mimeToExt = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
    "text/plain": ".txt",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
  };

  const expectedExt = mimeToExt[file.mimetype];
  if (expectedExt && !ext.endsWith(expectedExt.replace(/^\./, ''))) {
    return cb(
      new Error(`File extension ${ext} does not match the declared MIME type ${file.mimetype}`),
      false
    );
  }

  // Check for potentially dangerous filenames
  const dangerousPatterns = [/\.\./, /\/|\\/, /\0/, /<|>/];
  if (dangerousPatterns.some(pattern => pattern.test(file.originalname))) {
    return cb(new Error("Invalid filename. Please rename the file and try again."), false);
  }

  cb(null, true);
};

// Configure Cloudinary Storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "campus-resources",
    allowed_formats: ["pdf", "docx", "pptx", "xlsx", "doc", "ppt", "jpg", "jpeg", "png", "webp"],
    resource_type: "auto",
  },
});

const imageStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "campus-lost-found",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    resource_type: "image",
  },
});

const profileImageStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "campus-profiles",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    resource_type: "image",
    transformation: [{ width: 500, height: 500, crop: "fill", gravity: "face" }],
  },
});

const chatAttachmentStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "chat-attachments",
    allowed_formats: ["pdf", "docx", "pptx", "xlsx", "doc", "ppt", "jpg", "jpeg", "png", "webp", "gif", "avif", "svg", "txt", "zip"],
    resource_type: "auto",
    transformation: [
      { quality: "auto", fetch_format: "auto" },
    ],
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

const uploadImage = multer({
  storage: imageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid image type. Only JPG, PNG, and WEBP are allowed."), false);
    }
  },
});

const imageFileFilter = (req, file, cb) => {
  if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid image type. Only JPG, PNG, and WEBP are allowed."), false);
  }
};

const uploadProfileImage = multer({
  storage: profileImageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: imageFileFilter,
});

const uploadChatAttachment = multer({
  storage: chatAttachmentStorage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max limit for chat attachments (will be validated per type)
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

module.exports = { upload, uploadImage, uploadProfileImage, uploadChatAttachment, handleUploadError };
