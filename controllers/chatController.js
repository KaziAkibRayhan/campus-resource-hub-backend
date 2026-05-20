const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");

const getConversationForUser = async (conversationId, userId) =>
  Conversation.findOne({ _id: conversationId, members: userId });

exports.getChatUsers = async (req, res) => {
  try {
    const users = await User.find({
      _id: { $ne: req.user._id },
      isBlocked: false,
    })
      .select("name email role department profileImage")
      .sort({ name: 1 })
      .lean();

    res.status(200).json({ success: true, users });
  } catch (error) {
    console.error("Get chat users error:", error);
    res.status(500).json({ success: false, message: "Error fetching users" });
  }
};

exports.getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      members: req.user._id,
    })
      .populate("members", "name email role department profileImage")
      .populate("admins", "name email role department profileImage")
      .populate({
        path: "lastMessage",
        populate: { path: "sender", select: "name" },
      })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({ success: true, conversations });
  } catch (error) {
    console.error("Get conversations error:", error);
    res.status(500).json({ success: false, message: "Error fetching chats" });
  }
};

exports.createDirectConversation = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId || userId === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "Invalid user" });
    }

    let conversation = await Conversation.findOne({
      type: "direct",
      members: { $all: [req.user._id, userId], $size: 2 },
    });

    if (!conversation) {
      conversation = await Conversation.create({
        type: "direct",
        members: [req.user._id, userId],
        createdBy: req.user._id,
      });
    }

    await conversation.populate("members", "name email role department profileImage");

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("Create direct chat error:", error);
    res.status(500).json({ success: false, message: "Error creating chat" });
  }
};

exports.createGroupConversation = async (req, res) => {
  try {
    const { name, description, image, memberIds } = req.body;

    if (!name || !memberIds || memberIds.length === 0) {
      return res.status(400).json({ success: false, message: "Group name and members are required" });
    }

    const members = [...new Set([...memberIds, req.user._id.toString()])];

    const conversation = await Conversation.create({
      type: "group",
      name,
      description,
      image,
      members,
      admins: [req.user._id],
      createdBy: req.user._id,
    });

    await conversation.populate("members", "name email role department profileImage");
    await conversation.populate("admins", "name email role department profileImage");

    res.status(201).json({ success: true, conversation });
  } catch (error) {
    console.error("Create group chat error:", error);
    res.status(500).json({ success: false, message: "Error creating group" });
  }
};

exports.updateGroupInfo = async (req, res) => {
  try {
    const { name, description, image } = req.body;
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      type: "group",
      admins: req.user._id,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Group not found or you're not an admin" });
    }

    if (name) conversation.name = name;
    if (description !== undefined) conversation.description = description;
    if (image) conversation.image = image;

    await conversation.save();
    await conversation.populate("members", "name email role department profileImage");
    await conversation.populate("admins", "name email role department profileImage");

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("Update group error:", error);
    res.status(500).json({ success: false, message: "Error updating group" });
  }
};

exports.addMembers = async (req, res) => {
  try {
    const { memberIds } = req.body;
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      type: "group",
      admins: req.user._id,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Group not found or you're not an admin" });
    }

    const currentMembers = conversation.members.map(m => m.toString());
    const newMembers = memberIds.filter(id => !currentMembers.includes(id));

    conversation.members.push(...newMembers);
    await conversation.save();
    await conversation.populate("members", "name email role department profileImage");
    await conversation.populate("admins", "name email role department profileImage");

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("Add members error:", error);
    res.status(500).json({ success: false, message: "Error adding members" });
  }
};

exports.removeMember = async (req, res) => {
  try {
    const { userId } = req.body;
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      type: "group",
      admins: req.user._id,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Group not found or you're not an admin" });
    }

    if (userId === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "Use leave endpoint to leave the group" });
    }

    conversation.members = conversation.members.filter(m => m.toString() !== userId);
    conversation.admins = conversation.admins.filter(a => a.toString() !== userId);
    
    await conversation.save();
    await conversation.populate("members", "name email role department profileImage");
    await conversation.populate("admins", "name email role department profileImage");

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("Remove member error:", error);
    res.status(500).json({ success: false, message: "Error removing member" });
  }
};

exports.promoteToAdmin = async (req, res) => {
  try {
    const { userId } = req.body;
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      type: "group",
      admins: req.user._id,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Group not found or you're not an admin" });
    }

    if (!conversation.admins.includes(userId)) {
      conversation.admins.push(userId);
      await conversation.save();
    }

    await conversation.populate("members", "name email role department profileImage");
    await conversation.populate("admins", "name email role department profileImage");

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("Promote admin error:", error);
    res.status(500).json({ success: false, message: "Error promoting admin" });
  }
};

exports.demoteAdmin = async (req, res) => {
  try {
    const { userId } = req.body;
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      type: "group",
      admins: req.user._id,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Group not found or you're not an admin" });
    }

    if (conversation.admins.length <= 1 && conversation.admins.includes(userId)) {
      return res.status(400).json({ success: false, message: "Group must have at least one admin" });
    }

    conversation.admins = conversation.admins.filter(a => a.toString() !== userId);
    await conversation.save();
    
    await conversation.populate("members", "name email role department profileImage");
    await conversation.populate("admins", "name email role department profileImage");

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("Demote admin error:", error);
    res.status(500).json({ success: false, message: "Error demoting admin" });
  }
};

exports.leaveGroup = async (req, res) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      type: "group",
      members: req.user._id,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    conversation.members = conversation.members.filter(m => m.toString() !== req.user._id.toString());
    
    // If last member leaves, delete group or if last admin leaves, promote someone
    if (conversation.members.length === 0) {
      await Conversation.deleteOne({ _id: conversation._id });
      await Message.deleteMany({ conversation: conversation._id });
      return res.status(200).json({ success: true, message: "Group deleted as last member left" });
    }

    conversation.admins = conversation.admins.filter(a => a.toString() !== req.user._id.toString());
    
    if (conversation.admins.length === 0) {
      conversation.admins.push(conversation.members[0]);
    }

    await conversation.save();
    res.status(200).json({ success: true, message: "Left group successfully" });
  } catch (error) {
    console.error("Leave group error:", error);
    res.status(500).json({ success: false, message: "Error leaving group" });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const conversation = await getConversationForUser(
      req.params.id,
      req.user._id
    );

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Chat not found" });
    }

    const messages = await Message.find({ conversation: conversation._id })
      .populate("sender", "name email profileImage")
      .populate("replyTo")
      .sort({ createdAt: 1 })
      .lean();

    res.status(200).json({ success: true, messages });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({ success: false, message: "Error fetching messages" });
  }
};

exports.uploadAttachment = async (req, res) => {
  try {
    console.log("Upload attachment request received:", {
      file: req.file ? req.file.originalname : "No file",
      mimetype: req.file?.mimetype,
      size: req.file?.size,
    });

    if (!req.file) {
      console.error("No file uploaded");
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    // File size limits by type (in bytes)
    const fileSizeLimits = {
      "image/jpeg": 10 * 1024 * 1024, // 10MB for images
      "image/jpg": 10 * 1024 * 1024,
      "image/png": 10 * 1024 * 1024,
      "image/webp": 10 * 1024 * 1024,
      "image/gif": 10 * 1024 * 1024,
      "image/avif": 10 * 1024 * 1024,
      "image/svg+xml": 5 * 1024 * 1024,
      "application/pdf": 25 * 1024 * 1024, // 25MB for PDFs
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 25 * 1024 * 1024, // 25MB for DOCX
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": 25 * 1024 * 1024, // 25MB for PPTX
      "application/vnd.ms-powerpoint": 25 * 1024 * 1024,
      "application/msword": 25 * 1024 * 1024,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 25 * 1024 * 1024,
      "text/plain": 5 * 1024 * 1024, // 5MB for text files
      "application/zip": 50 * 1024 * 1024, // 50MB for zip files
      "application/x-zip-compressed": 50 * 1024 * 1024,
    };

    // Validate file size based on type
    const maxSize = fileSizeLimits[req.file.mimetype] || 25 * 1024 * 1024;
    if (req.file.size > maxSize) {
      console.error(`File size ${req.file.size} exceeds limit ${maxSize}`);
      return res.status(400).json({
        success: false,
        message: `File size exceeds the ${(maxSize / (1024 * 1024)).toFixed(0)}MB limit for this file type`,
      });
    }

    const fileTypeMap = {
      "application/pdf": "PDF",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
      "application/vnd.ms-powerpoint": "PPTX",
      "application/msword": "DOC",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
      "image/jpeg": "IMAGE",
      "image/jpg": "IMAGE",
      "image/png": "IMAGE",
      "image/webp": "IMAGE",
      "image/gif": "IMAGE",
      "image/avif": "IMAGE",
      "image/svg+xml": "IMAGE",
      "text/plain": "TEXT",
      "application/zip": "ZIP",
      "application/x-zip-compressed": "ZIP",
    };

    const fileType = fileTypeMap[req.file.mimetype] || "FILE";

    // Generate thumbnail for images using Cloudinary transformations
    let thumbnailUrl = null;
    if (fileType === "IMAGE") {
      // Cloudinary provides automatic optimization, we can add transformations
      thumbnailUrl = req.file.path; // Cloudinary already provides optimized versions
    }

    console.log("File uploaded successfully:", {
      fileUrl: req.file.path,
      fileType,
      fileName: req.file.originalname,
    });

    res.status(200).json({
      success: true,
      attachment: {
        fileUrl: req.file.path,
        fileType,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        thumbnailUrl,
        publicId: req.file.filename,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error("Upload chat attachment error:", error);
    res.status(500).json({ success: false, message: "Error uploading file" });
  }
};

exports.verifyChatAccess = async (req, res) => {
  try {
    const user = req.user;

    // Check if user is approved and not blocked
    if (!user.isApproved) {
      return res.status(403).json({
        success: false,
        message: "Your account is pending approval. Please contact admin.",
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked. Please contact admin.",
      });
    }

    // Check role-based permissions
    const chatPermissions = {
      student: { canCreateGroups: true, canJoinGroups: true, maxGroupMembers: 50 },
      moderator: { canCreateGroups: true, canJoinGroups: true, maxGroupMembers: 100 },
      admin: { canCreateGroups: true, canJoinGroups: true, maxGroupMembers: 200 },
    };

    const permissions = chatPermissions[user.role] || chatPermissions.student;

    res.status(200).json({
      success: true,
      message: "Chat access verified",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        profileImage: user.profileImage,
      },
      permissions,
    });
  } catch (error) {
    console.error("Verify chat access error:", error);
    res.status(500).json({ success: false, message: "Error verifying chat access" });
  }
};

exports.downloadAttachment = async (req, res) => {
  try {
    const { messageId, attachmentIndex } = req.params;

    // Find the message and verify user has access to the conversation
    const message = await Message.findById(messageId).populate("conversation");

    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    // Verify user is a member of the conversation
    const conversation = await Conversation.findOne({
      _id: message.conversation._id,
      members: req.user._id,
    });

    if (!conversation) {
      return res.status(403).json({ success: false, message: "You don't have permission to access this file" });
    }

    // Get the attachment
    const attachment = message.attachments[attachmentIndex];
    if (!attachment) {
      return res.status(404).json({ success: false, message: "Attachment not found" });
    }

    // Return the file URL (Cloudinary handles the actual serving)
    res.status(200).json({
      success: true,
      fileUrl: attachment.fileUrl,
      fileName: attachment.fileName,
      fileType: attachment.fileType,
    });
  } catch (error) {
    console.error("Download attachment error:", error);
    res.status(500).json({ success: false, message: "Error downloading file" });
  }
};
