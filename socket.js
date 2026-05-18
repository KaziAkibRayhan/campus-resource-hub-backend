const jwt = require("jsonwebtoken");
const Conversation = require("./models/Conversation");
const Message = require("./models/Message");
const User = require("./models/User");

const onlineUsers = new Map();

const getOnlineUserIds = () => Array.from(onlineUsers.keys());

const initializeSocket = (io) => {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

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
    socket.join(`user:${userId}`);
    io.emit("presence:update", getOnlineUserIds());

    const conversations = await Conversation.find({
      type: "direct",
      members: socket.user._id,
    }).select("_id");
    conversations.forEach((conversation) => {
      socket.join(`conversation:${conversation._id}`);
    });

    socket.on("conversation:join", async (conversationId) => {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        type: "direct",
        members: socket.user._id,
      });

      if (conversation) {
        socket.join(`conversation:${conversation._id}`);
      }
    });

    socket.on("message:send", async ({ conversationId, text }, callback) => {
      try {
        const cleanText = String(text || "").trim();
        if (!cleanText) return;

        const conversation = await Conversation.findOne({
          _id: conversationId,
          type: "direct",
          members: socket.user._id,
        });

        if (!conversation) {
          callback?.({ success: false, message: "Chat not found" });
          return;
        }

        const deliveredTo = conversation.members.filter(
          (member) => onlineUsers.has(member.toString()) && member.toString() !== userId
        );

        const message = await Message.create({
          conversation: conversation._id,
          sender: socket.user._id,
          text: cleanText,
          deliveredTo,
          seenBy: [{ user: socket.user._id }],
        });

        conversation.lastMessage = message._id;
        await conversation.save();
        await message.populate("sender", "name email profileImage");

        io.to(`conversation:${conversation._id}`).emit("message:new", message);
        conversation.members.forEach((member) => {
          io.to(`user:${member}`).emit("conversation:updated", {
            conversationId: conversation._id,
            lastMessage: message,
          });
        });

        callback?.({ success: true, message });
      } catch (error) {
        console.error("Socket send message error:", error);
        callback?.({ success: false, message: "Error sending message" });
      }
    });

    socket.on("message:seen", async ({ conversationId }) => {
      await Message.updateMany(
        {
          conversation: conversationId,
          "seenBy.user": { $ne: socket.user._id },
        },
        { $push: { seenBy: { user: socket.user._id, seenAt: new Date() } } }
      );

      socket.to(`conversation:${conversationId}`).emit("message:seen", {
        conversationId,
        userId,
      });
    });

    socket.on("disconnect", () => {
      onlineUsers.delete(userId);
      io.emit("presence:update", getOnlineUserIds());
    });
  });
};

module.exports = initializeSocket;
