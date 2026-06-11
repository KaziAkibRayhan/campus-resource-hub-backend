const { Readable } = require("stream");
const Announcement = require("../models/Announcement");
const Notification = require("../models/Notification");
const cloudinary = require("../config/cloudinary");
const { broadcastNotification } = require("../utils/notificationHelper");

const attachmentFileTypeMap = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "text/plain": "TEXT",
};

const getAttachmentFileType = (mimeType = "") => {
  if (mimeType.startsWith("image/")) return "IMAGE";
  return attachmentFileTypeMap[mimeType] || "FILE";
};

const uploadAttachmentBuffer = (file) =>
  new Promise((resolve, reject) => {
    const isImage = file.mimetype.startsWith("image/");
    const resourceType = isImage ? "image" : "raw";
    const extension = (file.originalname || "").split(".").pop()?.toLowerCase();
    const baseName = (file.originalname || "attachment")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "attachment";
    // Raw files need the extension inside public_id so Cloudinary serves the
    // right format on signed downloads.
    const publicId =
      resourceType === "raw" && extension
        ? `campus-announcements/${baseName}-${Date.now()}.${extension}`
        : undefined;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        timeout: 60000,
        ...(publicId ? { public_id: publicId } : { folder: "campus-announcements" }),
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          fileUrl: result.secure_url,
          fileType: getAttachmentFileType(file.mimetype),
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          publicId: result.public_id,
          resourceType,
        });
      }
    );

    Readable.from(file.buffer).on("error", reject).pipe(uploadStream);
  });

const destroyAttachments = async (attachments = []) => {
  await Promise.all(
    attachments
      .filter((attachment) => attachment.publicId)
      .map((attachment) =>
        cloudinary.uploader
          .destroy(attachment.publicId, { resource_type: attachment.resourceType || "raw" })
          .catch((error) => console.error("Announcement attachment cleanup error:", error))
      )
  );
};

// @desc    Get all announcements
// @route   GET /api/announcements
// @access  Public
exports.getAnnouncements = async (req, res) => {
  try {
    const { department, search, approved, limit, mine } = req.query;
    const query = {};

    // Filter by current user's own posts
    if (mine === "true" && req.user) {
      query.postedBy = req.user._id;
    } else if (!req.user || (req.user.role !== "admin" && req.user.role !== "moderator")) {
      query.approved = true;
    } else if (approved !== undefined) {
      query.approved = approved === "true";
    }
    // admin/moderator with no filter → sees all

    if (department && department !== "All") {
      query.department = { $in: [department, "All"] };
    }

    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    let announcementsQuery = Announcement.find(query)
      .populate("postedBy", "name email")
      .sort("-createdAt")
      .lean();

    if (limit) {
      announcementsQuery = announcementsQuery.limit(parseInt(limit));
    }

    const announcements = await announcementsQuery;

    res.status(200).json({
      success: true,
      count: announcements.length,
      announcements,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error fetching announcements",
    });
  }
};

// @desc    Create an announcement
// @route   POST /api/announcements
// @access  Private (Admin/Moderator)
exports.createAnnouncement = async (req, res) => {
  let attachments = [];
  try {
    const { title, content, department } = req.body;

    if (req.files?.length) {
      attachments = await Promise.all(req.files.map(uploadAttachmentBuffer));
    }

    const announcement = await Announcement.create({
      title,
      content,
      department,
      attachments,
      postedBy: req.user._id,
      approved: true,
      approvedBy: req.user._id,
      approvedAt: Date.now(),
    });

    await announcement.populate("postedBy", "name email");

    // Realtime: everyone gets a persistent notification + open pages refresh.
    broadcastNotification(req.io, {
      excludeUser: req.user._id,
      title: "New announcement",
      message: `${announcement.title}${announcement.department && announcement.department !== "All" ? ` (${announcement.department})` : ""}`,
      type: "announcement",
      sender: req.user._id,
      link: "/announcements",
      metadata: { announcementId: announcement._id },
    });
    req.io?.emit("announcement:new", announcement);

    res.status(201).json({
      success: true,
      message: "Announcement created successfully",
      announcement,
    });
  } catch (error) {
    await destroyAttachments(attachments);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating announcement",
    });
  }
};

// @desc    Stream an announcement attachment (signed fetch — works even when
//          Cloudinary blocks public raw/PDF delivery)
// @route   GET /api/announcements/:id/attachments/:index/file
// @access  Public (announcements are public once approved)
exports.streamAttachment = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id).lean();
    const attachment = announcement?.attachments?.[Number(req.params.index)];

    if (!announcement || !attachment) {
      return res.status(404).json({ success: false, message: "Attachment not found" });
    }

    const format = (attachment.fileName || attachment.fileUrl).split(".").pop()?.toLowerCase();
    const signedUrl = cloudinary.utils.private_download_url(
      attachment.publicId,
      format,
      { resource_type: attachment.resourceType || "raw", type: "upload" }
    );

    const upstream = await fetch(signedUrl);
    if (!upstream.ok) {
      return res.status(502).json({ success: false, message: "Unable to fetch file from storage" });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const isDownload = req.query.download === "1" || req.query.download === "true";
    const safeName = (attachment.fileName || "attachment").replace(/[^\w.\- ]+/g, "_");

    res.setHeader("Content-Type", attachment.mimeType || upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Content-Disposition",
      `${isDownload ? "attachment" : "inline"}; filename="${safeName}"`
    );
    res.send(buffer);
  } catch (error) {
    console.error("Stream announcement attachment error:", error);
    res.status(500).json({ success: false, message: "Error fetching attachment" });
  }
};

// @desc    Approve/Reject announcement
// @route   PUT /api/announcements/:id/approve
// @access  Private (Admin)
exports.approveAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);

    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found",
      });
    }

    announcement.approved = true;
    announcement.approvedBy = req.user._id;
    announcement.rejectionReason = "";
    await announcement.save();

    await Notification.create({
      user: announcement.postedBy,
      title: "Announcement approved",
      message: `"${announcement.title}" is now visible.`,
      type: "announcement",
    });

    res.status(200).json({
      success: true,
      message: "Announcement approved",
      announcement,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error approving announcement",
    });
  }
};

// @desc    Reject announcement
// @route   PUT /api/announcements/:id/reject
// @access  Private (Admin/Moderator)
exports.rejectAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);

    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found",
      });
    }

    announcement.approved = false;
    announcement.rejectionReason = req.body.reason || "Does not meet posting standards";
    await announcement.save();

    await Notification.create({
      user: announcement.postedBy,
      title: "Announcement rejected",
      message: `"${announcement.title}" needs revision. Reason: ${announcement.rejectionReason}`,
      type: "announcement",
    });

    res.status(200).json({
      success: true,
      message: "Announcement rejected",
      announcement,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error rejecting announcement",
    });
  }
};

// @desc    Update announcement
// @route   PUT /api/announcements/:id
// @access  Private (Owner/Admin)
exports.updateAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ success: false, message: "Announcement not found" });
    }
    if (
      announcement.postedBy.toString() !== req.user._id.toString() &&
      req.user.role !== "admin" && req.user.role !== "moderator"
    ) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }
    const { title, content, department, removeAttachments } = req.body;
    if (title)      announcement.title      = title;
    if (content)    announcement.content    = content;
    if (department) announcement.department = department;

    // removeAttachments: JSON array of publicIds to drop
    if (removeAttachments) {
      let publicIdsToRemove = [];
      try {
        publicIdsToRemove = JSON.parse(removeAttachments);
      } catch {
        publicIdsToRemove = [];
      }
      if (publicIdsToRemove.length > 0) {
        const removed = announcement.attachments.filter((attachment) =>
          publicIdsToRemove.includes(attachment.publicId)
        );
        announcement.attachments = announcement.attachments.filter(
          (attachment) => !publicIdsToRemove.includes(attachment.publicId)
        );
        await destroyAttachments(removed);
      }
    }

    if (req.files?.length) {
      const newAttachments = await Promise.all(req.files.map(uploadAttachmentBuffer));
      announcement.attachments.push(...newAttachments);
    }

    await announcement.save();
    await announcement.populate("postedBy", "name email");
    req.io?.emit("announcement:updated", announcement);
    res.status(200).json({ success: true, message: "Announcement updated", announcement });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Error updating announcement" });
  }
};

// @desc    Delete announcement
// @route   DELETE /api/announcements/:id
// @access  Private (Admin/Owner)
exports.deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);

    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found",
      });
    }

    // Check ownership
    if (
      announcement.postedBy.toString() !== req.user._id.toString() &&
      req.user.role !== "admin"
    ) {
      return res.status(401).json({
        success: false,
        message: "Not authorized to delete this announcement",
      });
    }

    await destroyAttachments(announcement.attachments);
    await announcement.deleteOne();
    req.io?.emit("announcement:deleted", { announcementId: announcement._id });

    res.status(200).json({
      success: true,
      message: "Announcement removed",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error deleting announcement",
    });
  }
};
