const { Readable } = require("stream");
const Announcement = require("../models/Announcement");
const Notification = require("../models/Notification");
const cloudinary = require("../config/cloudinary");
const { sendNotification, broadcastNotification } = require("../utils/notificationHelper");
const { moderatePost } = require("../utils/postModeration");
const { semanticPaginatedFind } = require("../utils/semanticSearch");

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

const canModerate = (user) =>
  user && (user.role === "admin" || user.role === "moderator");

const PRIORITIES = ["normal", "important", "urgent"];

// Add per-user read state + scheduled/expired flags; never leak the full
// reader list to clients.
const shapeAnnouncement = (a, userId) => {
  const readBy = a.readBy || [];
  const nowDate = new Date();
  const obj = { ...a };
  obj.readCount = readBy.length;
  obj.isRead = userId
    ? readBy.some((id) => id.toString() === userId.toString())
    : false;
  obj.isScheduled = !!(a.publishAt && new Date(a.publishAt) > nowDate);
  obj.isExpired = !!(a.expiresAt && new Date(a.expiresAt) <= nowDate);
  delete obj.readBy;
  return obj;
};

const audienceFor = (department) =>
  department && department !== "All" ? { department } : undefined;

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
    const {
      department,
      search,
      approved,
      limit = 20,
      page = 1,
      mine,
      priority,
      scope, // "archived" → expired only (others hidden by default)
    } = req.query;
    const query = {};
    const moderator = canModerate(req.user);
    const nowDate = new Date();
    const and = [];

    if (mine === "true" && req.user) {
      query.postedBy = req.user._id;
    } else if (!moderator) {
      // Public feed: approved, already published, not expired.
      query.approved = true;
      and.push({ $or: [{ publishAt: { $lte: nowDate } }, { publishAt: null }] });
      if (scope === "archived") {
        and.push({ expiresAt: { $lte: nowDate } });
      } else {
        and.push({
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: null },
            { expiresAt: { $gt: nowDate } },
          ],
        });
      }
    } else if (approved !== undefined) {
      query.approved = approved === "true";
    }
    // moderator with no filter → sees everything (incl. scheduled/expired)

    if (department && department !== "All") {
      query.department = { $in: [department, "All"] };
    }
    if (priority && priority !== "all" && PRIORITIES.includes(priority)) {
      query.priority = priority;
    }
    const perPage = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);

    if (search) {
      // Semantic search first (relevance-ranked, keyword matches kept on
      // top); legacy regex when the embedding model is unavailable. Regex
      // coverage widened from title-only to content too. The publish/expiry
      // clauses stay in baseQuery, so scheduled/expired posts can't leak.
      const regexOr = [
        { title: { $regex: search, $options: "i" } },
        { content: { $regex: search, $options: "i" } },
      ];
      const baseQuery = and.length ? { ...query, $and: [...and] } : { ...query };

      const semanticResult = await semanticPaginatedFind(Announcement, {
        type: "announcement",
        search,
        baseQuery,
        regexOr,
        page: pageNum,
        limit: perPage,
        populate: [["postedBy", "name email"]],
      });

      if (semanticResult) {
        return res.status(200).json({
          success: true,
          count: semanticResult.docs.length,
          total: semanticResult.total,
          totalPages: Math.ceil(semanticResult.total / perPage),
          currentPage: pageNum,
          announcements: semanticResult.docs.map((a) =>
            shapeAnnouncement(a, req.user?._id)
          ),
          semantic: true,
        });
      }

      and.push({ $or: regexOr });
    }
    if (and.length) query.$and = and;

    const [announcements, total] = await Promise.all([
      Announcement.find(query)
        .populate("postedBy", "name email")
        .sort({ pinned: -1, publishAt: -1, createdAt: -1 })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      Announcement.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      count: announcements.length,
      total,
      totalPages: Math.ceil(total / perPage),
      currentPage: pageNum,
      announcements: announcements.map((a) => shapeAnnouncement(a, req.user?._id)),
    });
  } catch (error) {
    console.error("Get announcements error:", error);
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
    const { title, content, department, priority, pinned, publishAt, expiresAt } =
      req.body;

    // Safety scan BEFORE anything is stored — text + inside attachments
    const rejection = await moderatePost({ texts: [title, content], files: req.files || [] });
    if (rejection) {
      return res.status(422).json({
        success: false,
        code: "CONTENT_REJECTED",
        message: rejection.message,
        categories: rejection.categories,
      });
    }

    if (req.files?.length) {
      attachments = await Promise.all(req.files.map(uploadAttachmentBuffer));
    }

    const scheduledFor = publishAt ? new Date(publishAt) : new Date();
    const publishNow = scheduledFor <= new Date();

    const announcement = await Announcement.create({
      title,
      content,
      department,
      priority: PRIORITIES.includes(priority) ? priority : "normal",
      pinned: pinned === "true" || pinned === true,
      publishAt: scheduledFor,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      // Publish-now posts notify immediately below; scheduled ones are picked up
      // by the scheduler when they go live.
      notified: publishNow,
      attachments,
      postedBy: req.user._id,
      approved: true,
      approvedBy: req.user._id,
      approvedAt: Date.now(),
    });

    await announcement.populate("postedBy", "name email");

    if (publishNow) {
      // Target the relevant department (or everyone for "All").
      broadcastNotification(req.io, {
        excludeUser: req.user._id,
        audience: audienceFor(announcement.department),
        title: "New announcement",
        message: `${announcement.title}${announcement.department && announcement.department !== "All" ? ` (${announcement.department})` : ""}`,
        type: "announcement",
        sender: req.user._id,
        link: `/announcements?highlight=${announcement._id}`,
        metadata: { announcementId: announcement._id },
      });
      req.io?.emit("announcement:new", announcement);
    }

    res.status(201).json({
      success: true,
      message: publishNow
        ? "Announcement created successfully"
        : `Announcement scheduled for ${scheduledFor.toLocaleString()}`,
      announcement: shapeAnnouncement(announcement.toObject(), req.user._id),
    });
  } catch (error) {
    await destroyAttachments(attachments);
    console.error("Create announcement error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating announcement",
    });
  }
};

// @route PUT /api/announcements/:id/read  — mark read by current user
exports.markRead = async (req, res) => {
  try {
    await Announcement.updateOne(
      { _id: req.params.id },
      { $addToSet: { readBy: req.user._id } }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Mark announcement read error:", error);
    res.status(500).json({ success: false, message: "Error marking read" });
  }
};

// @route PUT /api/announcements/:id/pin  — toggle pinned (owner/mod)
exports.togglePin = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ success: false, message: "Announcement not found" });
    }
    if (
      announcement.postedBy.toString() !== req.user._id.toString() &&
      !canModerate(req.user)
    ) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    announcement.pinned = !announcement.pinned;
    await announcement.save();
    await announcement.populate("postedBy", "name email");
    req.io?.emit("announcement:updated", announcement);

    res.status(200).json({
      success: true,
      message: announcement.pinned ? "Pinned" : "Unpinned",
      announcement: shapeAnnouncement(announcement.toObject(), req.user._id),
    });
  } catch (error) {
    console.error("Toggle pin error:", error);
    res.status(500).json({ success: false, message: "Error updating pin" });
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
    const publishNow = !announcement.publishAt || announcement.publishAt <= new Date();
    if (publishNow) announcement.notified = true;
    await announcement.save();

    await sendNotification(req.io, {
      user: announcement.postedBy,
      title: "Announcement approved",
      message: `"${announcement.title}" is now visible.`,
      type: "announcement",
      link: `/announcements?highlight=${announcement._id}`,
    });

    // Only fan out now if it's already live; scheduled ones go out via the
    // scheduler when they publish.
    if (publishNow) {
      broadcastNotification(req.io, {
        excludeUser: announcement.postedBy,
        audience: audienceFor(announcement.department),
        title: "New announcement",
        message: `${announcement.title}${announcement.department && announcement.department !== "All" ? ` (${announcement.department})` : ""}`,
        type: "announcement",
        link: `/announcements?highlight=${announcement._id}`,
        metadata: { announcementId: announcement._id },
      });
      req.io?.emit("announcement:new", announcement);
    }

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

    await sendNotification(req.io, {
      user: announcement.postedBy,
      title: "Announcement rejected",
      message: `"${announcement.title}" needs revision. Reason: ${announcement.rejectionReason}`,
      type: "announcement",
      link: "/announcements",
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

    if (title || content || req.files?.length) {
      const rejection = await moderatePost({ texts: [title, content], files: req.files || [] });
      if (rejection) {
        return res.status(422).json({
          success: false,
          code: "CONTENT_REJECTED",
          message: rejection.message,
          categories: rejection.categories,
        });
      }
    }

    const { priority, pinned, publishAt, expiresAt } = req.body;
    if (title)      announcement.title      = title;
    if (content)    announcement.content    = content;
    if (department) announcement.department = department;
    if (priority && PRIORITIES.includes(priority)) announcement.priority = priority;
    if (pinned !== undefined) announcement.pinned = pinned === "true" || pinned === true;
    if (publishAt !== undefined) announcement.publishAt = publishAt ? new Date(publishAt) : new Date();
    if (expiresAt !== undefined) announcement.expiresAt = expiresAt ? new Date(expiresAt) : undefined;

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
