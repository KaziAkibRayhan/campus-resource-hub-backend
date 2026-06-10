const Notification = require("../models/Notification");

exports.getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.status(200).json({
      success: true,
      count: notifications.length,
      unread: notifications.filter((notification) => !notification.read).length,
      notifications,
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching notifications",
    });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user._id, read: false },
      { $set: { read: true } }
    );

    res.status(200).json({
      success: true,
      message: "Notifications marked as read",
    });
  } catch (error) {
    console.error("Mark notifications read error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating notifications",
    });
  }
};

exports.markRead = async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { read: true } },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, notification });
  } catch (error) {
    console.error("Mark notification read error:", error);
    res.status(500).json({ success: false, message: "Error updating notification" });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    console.error("Delete notification error:", error);
    res.status(500).json({ success: false, message: "Error deleting notification" });
  }
};

// Clear notifications for the current user. ?read=true clears only already-read
// ones; otherwise clears all of them.
exports.clearNotifications = async (req, res) => {
  try {
    const filter = { user: req.user._id };
    if (String(req.query.read) === "true") filter.read = true;

    const result = await Notification.deleteMany(filter);

    res.status(200).json({
      success: true,
      message: "Notifications cleared",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Clear notifications error:", error);
    res.status(500).json({ success: false, message: "Error clearing notifications" });
  }
};
