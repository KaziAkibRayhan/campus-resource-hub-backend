const jwt = require("jsonwebtoken");
const Conversation = require("./models/Conversation");
const Message = require("./models/Message");
const User = require("./models/User");
const Notification = require("./models/Notification");
const { sendNotification } = require("./utils/notificationHelper");

const onlineUsers = new Map();

const getOnlineUserIds = () => Array.from(onlineUsers.keys());

const initializeSocket = (io) => {
  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;

      if (!token) {
        return next(new Error("Authentication required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("-password");

      if (!user || user.isBlocked) {
        return next(new Error("Not authorized"));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(error);
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.user._id.toString();
    onlineUsers.set(userId, socket.id);
    
    // Join personal room for notifications and direct events
    socket.join(`user:${userId}`);
    
    // Broadcast presence update
    io.emit("presence:update", getOnlineUserIds());

    // Join rooms for all user's conversations (direct and group)
    const conversations = await Conversation.find({
      members: socket.user._id,
    }).select("_id");
    
    conversations.forEach((conversation) => {
      socket.join(`conversation:${conversation._id}`);
    });

    // --- Presence ---
    socket.on("presence:get", () => {
      socket.emit("presence:update", getOnlineUserIds());
    });

    // --- Conversations ---
    socket.on("conversation:join", async (conversationId) => {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        members: socket.user._id,
      });

      if (conversation) {
        socket.join(`conversation:${conversation._id}`);
      }
    });

    socket.on("conversation:leave", (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    // --- Messaging ---
    socket.on("message:send", async ({ conversationId, text, attachments, replyTo }, callback) => {
      try {
        const conversation = await Conversation.findOne({
          _id: conversationId,
          members: socket.user._id,
        });

        if (!conversation) {
          return callback?.({ success: false, message: "Conversation not found" });
        }

        const messageData = {
          conversation: conversationId,
          sender: socket.user._id,
          text: text?.trim(),
          attachments,
          replyTo,
          seenBy: [{ user: socket.user._id }],
        };

        const message = await Message.create(messageData);
        
        conversation.lastMessage = message._id;
        await conversation.save();

        const populatedMessage = await Message.findById(message._id)
          .populate("sender", "name email profileImage")
          .populate("replyTo");

        // Emit to the conversation room
        io.to(`conversation:${conversationId}`).emit("message:new", populatedMessage);

        // Emit file upload progress event if attachments exist
        if (attachments && attachments.length > 0) {
          io.to(`conversation:${conversationId}`).emit("file:uploaded", {
            messageId: message._id,
            attachments: attachments,
            senderId: socket.user._id,
          });
        }

        // Notify other members (for the sidebar/list updates)
        conversation.members.forEach((member) => {
          if (member.toString() !== userId) {
            io.to(`user:${member}`).emit("conversation:updated", {
              conversationId: conversation._id,
              lastMessage: populatedMessage,
            });

            // Send persistent notification for messages
            const notificationMessage = attachments && attachments.length > 0 
              ? `Sent ${attachments.length} file${attachments.length > 1 ? 's' : ''}`
              : text?.substring(0, 50) + (text?.length > 50 ? "..." : "");
            
            sendNotification(io, {
              user: member,
              title: conversation.type === "group" ? `New message in ${conversation.name}` : `New message from ${socket.user.name}`,
              message: notificationMessage,
              type: conversation.type === "group" ? "group_message" : "message",
              sender: socket.user._id,
              link: "/dashboard", // Or wherever chat is
              metadata: { conversationId: conversation._id }
            });
          }
        });

        callback?.({ success: true, message: populatedMessage });
      } catch (error) {
        console.error("Socket send message error:", error);
        callback?.({ success: false, message: "Error sending message" });
      }
    });

    socket.on("message:seen", async ({ conversationId, messageId }) => {
      try {
        const query = { conversation: conversationId };
        if (messageId) {
          query._id = messageId;
        }
        
        // Mark messages as seen by this user
        await Message.updateMany(
          {
            ...query,
            "seenBy.user": { $ne: socket.user._id },
          },
          { $push: { seenBy: { user: socket.user._id, seenAt: new Date() } } }
        );

        // Notify others in the conversation
        socket.to(`conversation:${conversationId}`).emit("message:seen_update", {
          conversationId,
          userId,
          messageId,
        });
      } catch (error) {
        console.error("Socket message seen error:", error);
      }
    });

    socket.on("message:typing", ({ conversationId, isTyping }) => {
      socket.to(`conversation:${conversationId}`).emit("message:typing_update", {
        conversationId,
        userId,
        userName: socket.user.name,
        isTyping,
      });
    });

    socket.on("message:edit", async ({ messageId, text }, callback) => {
      try {
        const message = await Message.findOne({ _id: messageId, sender: socket.user._id });
        if (!message) return callback?.({ success: false, message: "Message not found" });

        message.text = text;
        message.isEdited = true;
        await message.save();

        const updatedMessage = await Message.findById(messageId)
          .populate("sender", "name email profileImage")
          .populate("replyTo");

        io.to(`conversation:${message.conversation}`).emit("message:updated", updatedMessage);
        callback?.({ success: true, message: updatedMessage });
      } catch (error) {
        callback?.({ success: false, message: "Error editing message" });
      }
    });

    socket.on("message:delete", async ({ messageId }, callback) => {
      try {
        const message = await Message.findOne({ _id: messageId, sender: socket.user._id });
        if (!message) return callback?.({ success: false, message: "Message not found" });

        const conversationId = message.conversation;
        await Message.deleteOne({ _id: messageId });

        // If it was the last message, update conversation
        const conversation = await Conversation.findById(conversationId);
        if (conversation.lastMessage?.toString() === messageId) {
          const lastMsg = await Message.findOne({ conversation: conversationId }).sort({ createdAt: -1 });
          conversation.lastMessage = lastMsg ? lastMsg._id : null;
          await conversation.save();
        }

        io.to(`conversation:${conversationId}`).emit("message:deleted", { messageId, conversationId });
        callback?.({ success: true });
      } catch (error) {
        callback?.({ success: false, message: "Error deleting message" });
      }
    });

    // --- Notifications ---
    socket.on("notification:get_unread_count", async () => {
      const count = await Notification.countDocuments({ user: socket.user._id, read: false });
      socket.emit("notification:unread_count", count);
    });

    // --- Disconnect ---
    socket.on("disconnect", () => {
      onlineUsers.delete(userId);
      io.emit("presence:update", getOnlineUserIds());
    });
  });
};

module.exports = initializeSocket;
