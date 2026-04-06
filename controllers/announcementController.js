const Announcement = require("../models/Announcement");

// @desc    Get all announcements
// @route   GET /api/announcements
// @access  Public
exports.getAnnouncements = async (req, res) => {
  try {
    const { department, search, approved } = req.query;
    const query = {};

    if (
      !req.user ||
      (req.user.role !== "admin" && req.user.role !== "moderator")
    ) {
      query.approved = true;
    } else if (approved !== undefined) {
      query.approved = approved === "true";
    } else {
      query.approved = true; // Default to approved for admin too if not specified
    }

    if (department && department !== "All") {
      query.department = { $in: [department, "All"] };
    }

    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    const announcements = await Announcement.find(query)
      .populate("postedBy", "name email")
      .sort("-createdAt");

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
      // Auto-approve if admin/moderator
      approved: req.user.role === "admin" || req.user.role === "moderator",
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
    await announcement.save();

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
