// backend/middleware/upload.js
const multer = require("multer");
const path = require("path");
const cloudinary = require("../config/cloudinary");
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// Allowed file types for chat attachments
const allowedMimeTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // DOCX
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // PPTX
  "application/vnd.ms-powerpoint", // PPT
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.ms-powerpoint.template.macroEnabled.12",
  "application/msword", // DOC
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // XLSX
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  "application/vnd.ms-excel.template.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/x-citrix-jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
];

// File size limits by type
const fileSizeLimits = {
  "image/jpeg": 10 * 1024 * 1024, // 10MB for images
  "image/jpg": 10 * 1024 * 1024,
  "image/pjpeg": 10 * 1024 * 1024,
  "image/x-citrix-jpeg": 10 * 1024 * 1024,
  "image/png": 10 * 1024 * 1024,
  "image/webp": 10 * 1024 * 1024,
  "image/gif": 10 * 1024 * 1024,
  "image/avif": 10 * 1024 * 1024,
  "image/svg+xml": 5 * 1024 * 1024,
  "image/bmp": 10 * 1024 * 1024,
  "application/pdf": 25 * 1024 * 1024, // 25MB for PDFs
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 25 * 1024 * 1024, // 25MB for DOCX
  "application/vnd.ms-word.document.macroEnabled.12": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": 25 * 1024 * 1024,
  "application/vnd.ms-word.template.macroEnabled.12": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": 25 * 1024 * 1024, // 25MB for PPTX
  "application/vnd.ms-powerpoint": 25 * 1024 * 1024,
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": 25 * 1024 * 1024,
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.12": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.presentationml.template": 25 * 1024 * 1024,
  "application/vnd.ms-powerpoint.template.macroEnabled.12": 25 * 1024 * 1024,
  "application/msword": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 25 * 1024 * 1024,
  "application/vnd.ms-excel": 25 * 1024 * 1024,
  "application/vnd.ms-excel.sheet.macroEnabled.12": 25 * 1024 * 1024,
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12": 25 * 1024 * 1024,
  "application/vnd.ms-excel.template.macroEnabled.12": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template": 25 * 1024 * 1024,
  "text/plain": 5 * 1024 * 1024, // 5MB for text files
  "application/zip": 50 * 1024 * 1024, // 50MB for zip files
  "application/x-zip-compressed": 50 * 1024 * 1024,
};

// File filter with enhanced security checks
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = [
    ".pdf",
    ".doc",
    ".docx",
    ".docm",
    ".dot",
    ".dotx",
    ".dotm",
    ".ppt",
    ".pptx",
    ".pptm",
    ".pps",
    ".ppsx",
    ".ppsm",
    ".pot",
    ".potx",
    ".potm",
    ".xls",
    ".xlsx",
    ".xlsm",
    ".xlsb",
    ".xlt",
    ".xltx",
    ".xltm",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".avif",
    ".svg",
    ".bmp",
    ".txt",
    ".zip",
  ];

  // Check if file type is allowed
  if (!allowedMimeTypes.includes(file.mimetype) && !allowedExtensions.includes(ext)) {
    return cb(
      new Error(
        "Invalid file type. Allowed types: PDF, Word, PowerPoint, Excel, Images (JPG, PNG, WEBP, GIF, AVIF, SVG), Text, and ZIP files."
      ),
      false
    );
  }

  // Check file extension matches MIME type
  const mimeToExt = {
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "application/vnd.ms-word.document.macroEnabled.12": [".docm"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template": [".dotx"],
    "application/vnd.ms-word.template.macroEnabled.12": [".dotm"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
    "application/vnd.ms-powerpoint": [".ppt", ".pps", ".pot"],
    "application/vnd.ms-powerpoint.presentation.macroEnabled.12": [".pptm"],
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": [".ppsx"],
    "application/vnd.ms-powerpoint.slideshow.macroEnabled.12": [".ppsm"],
    "application/vnd.openxmlformats-officedocument.presentationml.template": [".potx"],
    "application/vnd.ms-powerpoint.template.macroEnabled.12": [".potm"],
    "application/msword": [".doc", ".dot"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.ms-excel": [".xls", ".xlt"],
    "application/vnd.ms-excel.sheet.macroEnabled.12": [".xlsm"],
    "application/vnd.ms-excel.sheet.binary.macroEnabled.12": [".xlsb"],
    "application/vnd.ms-excel.template.macroEnabled.12": [".xltm"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template": [".xltx"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/jpg": [".jpg", ".jpeg"],
    "image/pjpeg": [".jpg", ".jpeg"],
    "image/x-citrix-jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
    "image/webp": [".webp"],
    "image/gif": [".gif"],
    "image/avif": [".avif"],
    "image/svg+xml": [".svg"],
    "image/bmp": [".bmp"],
    "text/plain": [".txt"],
    "application/zip": [".zip"],
    "application/x-zip-compressed": [".zip"],
  };

  const expectedExts = mimeToExt[file.mimetype];
  if (expectedExts && !expectedExts.includes(ext)) {
    return cb(
      new Error(
        `File extension ${ext} does not match the declared MIME type ${file.mimetype}`
      ),
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

// Resource files are uploaded to Cloudinary manually in the controller.
// Keeping them in memory first gives reliable JSON errors for raw files
// such as PPTX/DOCX/XLSX instead of hanging inside CloudinaryStorage.
const storage = multer.memoryStorage();

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
    allowed_formats: ["pdf", "doc", "docx", "docm", "dot", "dotx", "dotm", "ppt", "pptx", "pptm", "pps", "ppsx", "ppsm", "pot", "potx", "potm", "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "jpg", "jpeg", "png", "webp", "gif", "avif", "svg", "bmp", "txt", "zip"],
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
    fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 25 * 1024 * 1024, // 25MB default
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
        message: "File size too large. Maximum size is 25MB.",
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
