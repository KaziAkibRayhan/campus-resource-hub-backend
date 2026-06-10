// backend/controllers/resourceController.js
const Resource = require("../models/Resource");
const Notification = require("../models/Notification");
const cloudinary = require("../config/cloudinary");
const { sendNotification } = require("../utils/notificationHelper");
const mammoth = require("mammoth");
const { Readable } = require("stream");
const { extractContent } = require("../utils/contentExtractor");
const {
  moderateContent,
  describeCategories,
} = require("../utils/moderationService");

const CONTENT_TYPES_BY_FORMAT = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  dot: "application/msword",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  dotm: "application/vnd.ms-word.template.macroEnabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  pps: "application/vnd.ms-powerpoint",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ppsm: "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  pot: "application/vnd.ms-powerpoint",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  potm: "application/vnd.ms-powerpoint.template.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  xlt: "application/vnd.ms-excel",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  xltm: "application/vnd.ms-excel.template.macroEnabled.12",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

const CONTENT_TYPES_BY_RESOURCE_TYPE = {
  PDF: "application/pdf",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  IMAGE: null,
};

const getFormatFromUrl = (fileUrl = "") =>
  fileUrl.split(".").pop().split("?")[0].toLowerCase();

const getCloudinaryDeliveryType = (resource) => {
  const isRaw = /\/raw\/upload\//.test(resource.fileUrl || "");
  const isImage = /\/image\/upload\//.test(resource.fileUrl || "");

  if (isImage) return "image";
  if (isRaw) return "raw";
  return resource.cloudinaryResourceType || "raw";
};

const fetchResourceBuffer = async (resource) => {
  const format = getFormatFromUrl(resource.fileUrl || "");
  const deliveryType = getCloudinaryDeliveryType(resource);
  const deliveryTypesToTry = [
    deliveryType,
    deliveryType === "image" ? "raw" : "image",
  ];
  let upstream;

  for (const resourceType of deliveryTypesToTry) {
    const signedUrl = cloudinary.utils.private_download_url(
      resource.cloudinaryPublicId,
      format,
      { resource_type: resourceType, type: "upload" }
    );

    upstream = await fetch(signedUrl);
    if (upstream.ok) break;
  }

  if (!upstream?.ok) {
    const error = new Error("Unable to fetch file from storage");
    error.statusCode = 502;
    throw error;
  }

  const arrayBuffer = await upstream.arrayBuffer();

  return {
    format,
    upstreamContentType: upstream.headers.get("content-type"),
    fileBuffer: Buffer.from(arrayBuffer),
  };
};

const uploadBufferToCloudinary = ({ buffer, fileType, originalName }) =>
  new Promise((resolve, reject) => {
    const resourceType = fileType === "IMAGE" ? "image" : "raw";
    const extension = (originalName || "").split(".").pop()?.toLowerCase();
    const baseName = (originalName || "resource")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "resource";
    const publicId =
      resourceType === "raw" && extension
        ? `campus-resources/${baseName}-${Date.now()}.${extension}`
        : undefined;
    const uploadOptions = {
      resource_type: resourceType,
      timeout: 60000,
      ...(publicId
        ? { public_id: publicId }
        : { folder: "campus-resources" }),
    };
    let settled = false;
    let uploadStream;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(uploadTimeout);
      handler(value);
    };
    const uploadTimeout = setTimeout(() => {
      uploadStream?.destroy(new Error("File upload timed out. Please try again."));
      finish(reject, new Error("File upload timed out. Please try again."));
    }, 70000);

    uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) return finish(reject, error);
        finish(resolve, result);
      }
    );

    uploadStream.on("error", (error) => finish(reject, error));
    Readable.from(buffer)
      .on("error", (error) => finish(reject, error))
      .pipe(uploadStream);
  });

// @desc    Upload a new resource
// @route   POST /api/resources
// @access  Private
exports.uploadResource = async (req, res) => {
  let uploadedPublicId = "";
  let uploadedResourceType = "";
  let createdResourceId = null;

  try {
    const { title, description, course, department, semester } = req.body;

    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file",
      });
    }

    // Get file type from mimetype
    const fileTypeMap = {
      "application/pdf": "PDF",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "DOCX",
      "application/vnd.ms-word.document.macroEnabled.12": "DOCX",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template":
        "DOCX",
      "application/vnd.ms-word.template.macroEnabled.12": "DOCX",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        "PPTX",
      "application/vnd.ms-powerpoint.presentation.macroEnabled.12": "PPTX",
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow":
        "PPTX",
      "application/vnd.ms-powerpoint.slideshow.macroEnabled.12": "PPTX",
      "application/vnd.openxmlformats-officedocument.presentationml.template":
        "PPTX",
      "application/vnd.ms-powerpoint.template.macroEnabled.12": "PPTX",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        "XLSX",
      "application/vnd.ms-excel": "XLSX",
      "application/vnd.ms-excel.sheet.macroEnabled.12": "XLSX",
      "application/vnd.ms-excel.sheet.binary.macroEnabled.12": "XLSX",
      "application/vnd.ms-excel.template.macroEnabled.12": "XLSX",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template":
        "XLSX",
      "application/msword": "DOCX",
      "application/vnd.ms-powerpoint": "PPTX",
      "image/jpeg": "IMAGE",
      "image/jpg": "IMAGE",
      "image/pjpeg": "IMAGE",
      "image/x-citrix-jpeg": "IMAGE",
      "image/png": "IMAGE",
      "image/webp": "IMAGE",
      "image/gif": "IMAGE",
      "image/avif": "IMAGE",
      "image/svg+xml": "IMAGE",
      "image/bmp": "IMAGE",
    };

    const extension = (req.file.originalname || "")
      .split(".")
      .pop()
      .toLowerCase();
    const fileTypeByExtension = {
      pdf: "PDF",
      doc: "DOCX",
      docx: "DOCX",
      docm: "DOCX",
      dot: "DOCX",
      dotx: "DOCX",
      dotm: "DOCX",
      ppt: "PPTX",
      pptx: "PPTX",
      pptm: "PPTX",
      pps: "PPTX",
      ppsx: "PPTX",
      ppsm: "PPTX",
      pot: "PPTX",
      potx: "PPTX",
      potm: "PPTX",
      xls: "XLSX",
      xlsx: "XLSX",
      xlsm: "XLSX",
      xlsb: "XLSX",
      xlt: "XLSX",
      xltx: "XLSX",
      xltm: "XLSX",
      jpg: "IMAGE",
      jpeg: "IMAGE",
      png: "IMAGE",
      webp: "IMAGE",
      gif: "IMAGE",
      avif: "IMAGE",
      svg: "IMAGE",
      bmp: "IMAGE",
    };

    const fileType =
      fileTypeMap[req.file.mimetype] || fileTypeByExtension[extension] || "PDF";

    // Content safety check BEFORE anything is stored: look inside the file
    // (text, images, PDF pages) and reject harmful uploads with a warning.
    const extraction = await extractContent(req.file, fileType);
    const verdict = await moderateContent({
      texts: [
        [title, description, course].filter(Boolean).join("\n"),
        ...extraction.texts,
      ],
      images: extraction.images,
    });

    if (verdict.flagged) {
      return res.status(422).json({
        success: false,
        code: "CONTENT_REJECTED",
        message: `Upload blocked: this file appears to contain ${describeCategories(
          verdict.categories
        )}. It violates community guidelines and was not uploaded.`,
        categories: verdict.categories,
      });
    }

    const moderation = {
      status:
        verdict.status === "checked"
          ? extraction.partial
            ? "partial"
            : "approved"
          : "skipped",
      provider: verdict.provider || undefined,
      checkedAt: new Date(),
    };

    const uploadResult = await uploadBufferToCloudinary({
      buffer: req.file.buffer,
      fileType,
      originalName: req.file.originalname,
    });
    uploadedPublicId = uploadResult.public_id;
    uploadedResourceType = uploadResult.resource_type;

    // Create resource
    const resource = await Resource.create({
      title,
      description,
      course,
      department,
      semester,
      fileUrl: uploadResult.secure_url,
      fileType,
      fileSize: uploadResult.bytes || req.file.size,
      cloudinaryPublicId: uploadResult.public_id,
      cloudinaryResourceType: uploadResult.resource_type,
      uploadedBy: req.user._id,
      moderation,
      approved: true,
      approvedBy: req.user._id,
      approvedAt: Date.now(),
    });
    createdResourceId = resource._id;

    // Populate uploader info
    await resource.populate("uploadedBy", "name email studentId");

    res.status(201).json({
      success: true,
      message: "Resource uploaded successfully!",
      resource,
    });
  } catch (error) {
    console.error("Upload resource error:", error);

    // Delete uploaded file from Cloudinary if resource creation fails
    if (uploadedPublicId) {
      try {
        await cloudinary.uploader.destroy(uploadedPublicId, {
          resource_type: uploadedResourceType || "raw",
        });
      } catch (deleteError) {
        console.error("Error deleting file from Cloudinary:", deleteError);
      }
    }

    // Remove the document too if it was created before the failure,
    // otherwise it would point at the file deleted above
    if (createdResourceId) {
      try {
        await Resource.deleteOne({ _id: createdResourceId });
      } catch (deleteError) {
        console.error("Error deleting orphaned resource doc:", deleteError);
      }
    }

    res.status(500).json({
      success: false,
      message: error.message || "Error uploading resource",
    });
  }
};

// @desc    Get all resources (with filters)
// @route   GET /api/resources
// @access  Public
exports.getResources = async (req, res) => {
  try {
    const {
      department,
      semester,
      course,
      search,
      approved,
      isPending,
      all,
      sortBy = "createdAt",
      order = "desc",
      page = 1,
      limit = 10,
    } = req.query;

    // Build query
    const query = {};
    const isAdmin = req.user && (req.user.role === "admin" || req.user.role === "moderator");

    if (all === "true" && isAdmin) {
      // Admin fetching all resources — no approval filter
    } else if (isPending === "true" && isAdmin) {
      query.approved = false;
      query.$and = [
        {
          $or: [
            { rejectionReason: { $exists: false } },
            { rejectionReason: null },
            { rejectionReason: "" },
          ],
        },
      ];
    } else if (approved === "false" && isAdmin) {
      query.approved = false;
    } else if (approved === "true") {
      query.approved = true;
    } else {
      query.approved = true;
    }

    // Filter by department
    if (department && department !== "all") {
      query.department = department;
    }

    // Filter by semester
    if (semester && semester !== "all") {
      query.semester = semester;
    }

    // Filter by course
    if (course) {
      query.course = new RegExp(course, "i");
    }

    // Search in title and description
    if (search) {
      const searchOR = {
        $or: [
          { title: new RegExp(search, "i") },
          { description: new RegExp(search, "i") },
          { course: new RegExp(search, "i") },
        ],
      };

      if (query.$and) {
        query.$and.push(searchOR);
      } else {
        query.$and = [searchOR];
      }
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const allowedSortFields = ["createdAt", "downloads", "rating", "title", "course"];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : "createdAt";

    // Sort options
    const sortOptions = {};
    sortOptions[safeSortBy] = order === "desc" ? -1 : 1;

    // Execute query
    const resources = await Resource.find(query)
      .populate("uploadedBy", "name email studentId")
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get total count
    const total = await Resource.countDocuments(query);

    res.status(200).json({
      success: true,
      count: resources.length,
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
      currentPage: parseInt(page),
      resources,
    });
  } catch (error) {
    console.error("Get resources error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching resources",
    });
  }
};

// @desc    Get single resource
// @route   GET /api/resources/:id
// @access  Public
exports.getResourceById = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id).populate(
      "uploadedBy",
      "name email studentId department"
    );

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    const isOwner =
      req.user && resource.uploadedBy._id.toString() === req.user._id.toString();
    const canModerate =
      req.user && (req.user.role === "admin" || req.user.role === "moderator");

    if (!resource.approved && !isOwner && !canModerate) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    // Increment views
    resource.views += 1;
    await resource.save();

    res.status(200).json({
      success: true,
      resource,
    });
  } catch (error) {
    console.error("Get resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching resource",
    });
  }
};

// @desc    Update resource
// @route   PUT /api/resources/:id
// @access  Private (Owner only)
exports.updateResource = async (req, res) => {
  try {
    let resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    // Check if user is owner
    if (resource.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this resource",
      });
    }

    const { title, description, course, department, semester } = req.body;

    const verdict = await moderateContent({
      texts: [[title, description, course].filter(Boolean).join("\n")],
    });
    if (verdict.flagged) {
      return res.status(422).json({
        success: false,
        code: "CONTENT_REJECTED",
        message: `Update blocked: the new text appears to contain ${describeCategories(
          verdict.categories
        )}. It violates community guidelines.`,
        categories: verdict.categories,
      });
    }

    resource = await Resource.findByIdAndUpdate(
      req.params.id,
      {
        title,
        description,
        course,
        department,
        semester,
        approved: true,
        rejectionReason: undefined,
      },
      { new: true, runValidators: true }
    ).populate("uploadedBy", "name email studentId");

    res.status(200).json({
      success: true,
      message: "Resource updated successfully.",
      resource,
    });
  } catch (error) {
    console.error("Update resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating resource",
    });
  }
};

// @desc    Delete resource
// @route   DELETE /api/resources/:id
// @access  Private (Owner or Admin)
exports.deleteResource = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    // Check if user is owner or admin
    if (
      resource.uploadedBy.toString() !== req.user._id.toString() &&
      req.user.role !== "admin" &&
      req.user.role !== "moderator"
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this resource",
      });
    }

    // Delete file from Cloudinary
    try {
      await cloudinary.uploader.destroy(resource.cloudinaryPublicId, {
        resource_type: resource.cloudinaryResourceType || "raw",
      });
    } catch (error) {
      console.error("Error deleting from Cloudinary:", error);
    }

    await resource.deleteOne();

    res.status(200).json({
      success: true,
      message: "Resource deleted successfully",
    });
  } catch (error) {
    console.error("Delete resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting resource",
    });
  }
};

// @desc    Approve resource (Admin only)
// @route   PUT /api/resources/:id/approve
// @access  Private (Admin/Moderator)
exports.approveResource = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    resource.approved = true;
    resource.approvedBy = req.user._id;
    resource.approvedAt = Date.now();
    resource.rejectionReason = undefined;

    await resource.save();

    await resource.populate("uploadedBy", "name email");

    // Send real-time notification
    await sendNotification(req.io, {
      user: resource.uploadedBy._id,
      title: "Resource Approved!",
      message: `Your resource "${resource.title}" has been approved and is now visible to everyone.`,
      type: "resource",
      link: `/resources`,
    });

    res.status(200).json({
      success: true,
      message: "Resource approved successfully",
      resource,
    });
  } catch (error) {
    console.error("Approve resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error approving resource",
    });
  }
};

// @desc    Reject resource (Admin only)
// @route   PUT /api/resources/:id/reject
// @access  Private (Admin/Moderator)
exports.rejectResource = async (req, res) => {
  try {
    const { reason } = req.body;

    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    resource.approved = false;
    resource.rejectionReason = reason || "Does not meet quality standards";

    await resource.save();

    await resource.populate("uploadedBy", "name email");

    // Send real-time notification
    await sendNotification(req.io, {
      user: resource.uploadedBy._id,
      title: "Resource Rejected",
      message: `Your resource "${resource.title}" was rejected. Reason: ${resource.rejectionReason}`,
      type: "resource",
      link: `/my-uploads`,
    });

    res.status(200).json({
      success: true,
      message: "Resource rejected",
      resource,
    });
  } catch (error) {
    console.error("Reject resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting resource",
    });
  }
};

// @desc    Increment download count
// @route   PUT /api/resources/:id/download
// @access  Private
// @desc    Stream a resource file through the server (inline preview or download)
// @route   GET /api/resources/:id/file
// @access  Public
// @note    Cloudinary blocks public delivery of PDF/raw files by default
//          (401 "deny or ACL failure"). We fetch the asset with a signed,
//          authenticated download URL on the server and re-stream it so that
//          preview & download work regardless of that account setting.
exports.streamResourceFile = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id).lean();

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    const { format, upstreamContentType, fileBuffer } =
      await fetchResourceBuffer(resource);
    const contentType =
      CONTENT_TYPES_BY_FORMAT[format] ||
      CONTENT_TYPES_BY_RESOURCE_TYPE[resource.fileType] ||
      upstreamContentType ||
      "application/octet-stream";
    const wantsDownload =
      req.query.download === "1" || req.query.download === "true";

    const safeName = `${(resource.title || "resource").replace(
      /[^a-z0-9._-]+/gi,
      "_"
    )}.${format}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `${wantsDownload ? "attachment" : "inline"}; filename="${safeName}"`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range, Content-Disposition, Content-Type"
    );

    // Allow this file to be embedded in an <iframe> from the frontend origin.
    // Helmet's global defaults (X-Frame-Options: SAMEORIGIN and CSP
    // frame-ancestors 'self') would otherwise block the cross-origin preview.
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    return res.send(fileBuffer);
  } catch (error) {
    console.error("Stream resource file error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Error streaming file",
    });
  }
};

// @desc    Convert DOCX resources to safe preview HTML
// @route   GET /api/resources/:id/preview-html
// @access  Public
exports.previewResourceHtml = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id).lean();

    if (!resource) {
      return res.status(404).send("Resource not found");
    }

    if (!["DOCX", "DOC"].includes(resource.fileType)) {
      return res.status(400).send("HTML preview is only available for Word documents");
    }

    const { fileBuffer } = await fetchResourceBuffer(resource);
    const result = await mammoth.convertToHtml({ buffer: fileBuffer });
    const title = (resource.title || "Document").replace(/[<>&"]/g, "");

    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");

    return res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        padding: 28px;
        background: #f8fafc;
        color: #111827;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 16px;
        line-height: 1.65;
      }
      main {
        max-width: 820px;
        margin: 0 auto;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        box-shadow: 0 18px 50px rgb(15 23 42 / 0.12);
        padding: 40px;
      }
      h1, h2, h3 { line-height: 1.25; color: #0f172a; }
      p { margin: 0 0 14px; }
      table { border-collapse: collapse; width: 100%; margin: 16px 0; }
      td, th { border: 1px solid #cbd5e1; padding: 8px; }
      img { max-width: 100%; height: auto; }
      @media (max-width: 640px) {
        body { padding: 10px; font-size: 14px; }
        main { padding: 18px; }
      }
    </style>
  </head>
  <body>
    <main>${result.value || "<p>No preview content found.</p>"}</main>
  </body>
</html>`);
  } catch (error) {
    console.error("Preview resource HTML error:", error);
    return res.status(error.statusCode || 500).send(error.message || "Error creating preview");
  }
};

exports.incrementDownload = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    resource.downloads += 1;
    await resource.save();

    res.status(200).json({
      success: true,
      downloads: resource.downloads,
    });
  } catch (error) {
    console.error("Increment download error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating download count",
    });
  }
};

// @desc    Get user's uploaded resources
// @route   GET /api/resources/my-uploads
// @access  Private
exports.getMyUploads = async (req, res) => {
  try {
    const resources = await Resource.find({ uploadedBy: req.user._id })
      .sort({ createdAt: -1 })
      .populate("approvedBy", "name")
      .lean();

    res.status(200).json({
      success: true,
      count: resources.length,
      resources,
    });
  } catch (error) {
    console.error("Get my uploads error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching your uploads",
    });
  }
};
