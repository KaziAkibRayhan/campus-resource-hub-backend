const Notification = require("../models/Notification");

/**
 * Send a notification to a user
 * @param {Object} io - Socket.io instance
 * @param {Object} data - Notification data
 * @param {string} data.user - User ID
 * @param {string} data.title - Notification title
 * @param {string} data.message - Notification message
 * @param {string} data.type - Notification type
 * @param {string} [data.sender] - Sender user ID
 * @param {string} [data.link] - Link to redirect
 * @param {Object} [data.metadata] - Extra data
 */
const sendNotification = async (io, data) => {
  try {
    const notification = await Notification.create(data);
    
    // Emit via socket if user is online
    if (io) {
      io.to(`user:${data.user}`).emit("notification:new", notification);
      
      // Also update unread count
      const unreadCount = await Notification.countDocuments({ user: data.user, read: false });
      io.to(`user:${data.user}`).emit("notification:unread_count", unreadCount);
    }
    
    return notification;
  } catch (error) {
    console.error("Send notification error:", error);
  }
};

/**
 * Send the same notification to every active user (optionally excluding the actor).
 * Inserts in bulk, then emits to each online user's personal room. Clients
 * increment their own unread badge on "notification:new", so no per-user
 * count query is needed here.
 * @param {Object} io - Socket.io instance
 * @param {Object} data - Same shape as sendNotification, minus `user`
 * @param {string} [data.excludeUser] - User ID to skip (usually the actor)
 */
const broadcastNotification = async (io, { excludeUser, ...data }) => {
  try {
    const User = require("../models/User");
    const userFilter = { isBlocked: false };
    if (excludeUser) {
      userFilter._id = { $ne: excludeUser };
    }

    const users = await User.find(userFilter).select("_id").lean();
    if (users.length === 0) return [];

    const notifications = await Notification.insertMany(
      users.map(({ _id }) => ({ ...data, user: _id }))
    );

    if (io) {
      notifications.forEach((notification) => {
        io.to(`user:${notification.user}`).emit("notification:new", notification);
      });
    }

    return notifications;
  } catch (error) {
    console.error("Broadcast notification error:", error);
    return [];
  }
};

module.exports = { sendNotification, broadcastNotification };
