const Announcement = require("../models/Announcement");
const Club = require("../models/Club");
const Event = require("../models/Event");
const LostFoundItem = require("../models/LostFoundItem");
const Resource = require("../models/Resource");
const User = require("../models/User");

// @desc    Get admin dashboard stats
// @route   GET /api/admin/stats
// @access  Private (Admin/Moderator)
exports.getStats = async (req, res) => {
  try {
    const [
      totalResources,
      approvedResources,
      pendingResources,
      totalUsers,
      activeUsers,
      moderators,
      blockedUsers,
      totalAnnouncements,
      pendingAnnouncements,
      totalEvents,
      pendingEvents,
      totalLostFoundItems,
      pendingLostFoundItems,
      totalClubs,
      resourceMetrics,
    ] = await Promise.all([
      Resource.countDocuments(),
      Resource.countDocuments({ approved: true }),
      Resource.countDocuments({
        approved: false,
        $or: [
          { rejectionReason: { $exists: false } },
          { rejectionReason: null },
          { rejectionReason: "" },
        ],
      }),
      User.countDocuments(),
      User.countDocuments({ isBlocked: false }),
      User.countDocuments({ role: "moderator" }),
      User.countDocuments({ isBlocked: true }),
      Announcement.countDocuments(),
      Announcement.countDocuments({ approved: false }),
      Event.countDocuments(),
      Event.countDocuments({ approved: false }),
      LostFoundItem.countDocuments(),
      LostFoundItem.countDocuments({ approved: false }),
      Club.countDocuments({ approved: true }),
      Resource.aggregate([
        {
          $group: {
            _id: null,
            totalDownloads: { $sum: "$downloads" },
            storageUsed: { $sum: "$fileSize" },
          },
        },
      ]),
    ]);

    const metrics = resourceMetrics[0] || {
      totalDownloads: 0,
      storageUsed: 0,
    };

    res.status(200).json({
      success: true,
      stats: {
        resources: {
          total: totalResources,
          approved: approvedResources,
          pending: pendingResources,
          totalDownloads: metrics.totalDownloads,
          storageUsed: metrics.storageUsed,
        },
        users: {
          total: totalUsers,
          active: activeUsers,
          moderators,
          blocked: blockedUsers,
        },
        announcements: {
          total: totalAnnouncements,
          pending: pendingAnnouncements,
        },
        events: {
          total: totalEvents,
          pending: pendingEvents,
        },
        lostFound: {
          total: totalLostFoundItems,
          pending: pendingLostFoundItems,
        },
        clubs: {
          total: totalClubs,
        },
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching admin stats",
    });
  }
};

// @desc    List users for admin management
// @route   GET /api/admin/users
// @access  Private (Admin/Moderator)
exports.getUsers = async (req, res) => {
  try {
    const { search, role, blocked } = req.query;
    const query = {};

    if (role && role !== "all") query.role = role;
    if (blocked !== undefined) query.isBlocked = blocked === "true";
    if (search) {
      query.$or = [
        { name: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
        { studentId: new RegExp(search, "i") },
      ];
    }

    const users = await User.find(query)
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: users.length,
      users,
    });
  } catch (error) {
    console.error("Admin users error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching users",
    });
  }
};

// @desc    Update a user's role
// @route   PUT /api/admin/users/:id/role
// @access  Private (Admin)
exports.updateUserRole = async (req, res) => {
  try {
    const { role } = req.body;

    if (!["student", "moderator", "admin"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role",
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    user.role = role;
    await user.save();

    res.status(200).json({
      success: true,
      message: "User role updated",
      user,
    });
  } catch (error) {
    console.error("Update user role error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating user role",
    });
  }
};

// @desc    Block or unblock a user
// @route   PUT /api/admin/users/:id/block
// @access  Private (Admin/Moderator)
exports.setUserBlocked = async (req, res) => {
  try {
    const { isBlocked } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.role === "admin" && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can block admin users",
      });
    }

    user.isBlocked = Boolean(isBlocked);
    await user.save();

    res.status(200).json({
      success: true,
      message: user.isBlocked ? "User blocked" : "User unblocked",
      user,
    });
  } catch (error) {
    console.error("Set user blocked error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating user status",
    });
  }
};

// @desc    Delete a user (Admin only)
// @route   DELETE /api/admin/users/:id
// @access  Private (Admin)
exports.deleteUser = async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.id);

    if (!targetUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (targetUser._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account",
      });
    }

    if (targetUser.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin accounts cannot be deleted. Change the role first.",
      });
    }

    // Clean up the user's notifications; their posts stay (shown without author)
    const Notification = require("../models/Notification");
    await Notification.deleteMany({ user: targetUser._id });
    await targetUser.deleteOne();

    res.status(200).json({ success: true, message: "User deleted" });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ success: false, message: "Error deleting user" });
  }
};
