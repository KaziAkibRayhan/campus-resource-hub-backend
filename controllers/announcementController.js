const Announcement = require("../models/Announcement");
const Notification = require("../models/Notification");

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
  try {
    const { title, content, department } = req.body;

    const announcement = await Announcement.create({
      title,
      content,
      department,
      postedBy: req.user._id,
      approved: true,
      approvedBy: req.user._id,
      approvedAt: Date.now(),
    });

    res.status(201).json({
      success: true,
      message: "Announcement created successfully",
      announcement,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error creating announcement",
    });
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
    const { title, content, department } = req.body;
    if (title)      announcement.title      = title;
    if (content)    announcement.content    = content;
    if (department) announcement.department = department;
    await announcement.save();
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

    await announcement.deleteOne();

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
