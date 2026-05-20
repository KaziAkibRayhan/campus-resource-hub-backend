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

module.exports = { sendNotification };
