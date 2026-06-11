const LostFoundItem = require("../models/LostFoundItem");
const Notification = require("../models/Notification");
const cloudinary = require("../config/cloudinary");
const { sendNotification, broadcastNotification } = require("../utils/notificationHelper");
const { moderatePost } = require("../utils/postModeration");

const statusLabels = {
  open: "open again",
  claimed: "claimed",
  resolved: "resolved",
};

const canModerate = (user) => user && ["admin", "moderator"].includes(user.role);

exports.createItem = async (req, res) => {
  try {
    const { type, item, description, location, contact } = req.body;

    const rejection = await moderatePost({
      texts: [item, description, location, contact],
      imageUrls: req.file?.path ? [req.file.path] : [],
    });
    if (rejection) {
      if (req.file?.filename) {
        try {
          await cloudinary.uploader.destroy(req.file.filename);
        } catch (deleteError) {
          console.error("Flagged lost found image cleanup error:", deleteError);
        }
      }
      return res.status(422).json({
        success: false,
        code: "CONTENT_REJECTED",
        message: rejection.message,
        categories: rejection.categories,
      });
    }

    const lostFoundItem = await LostFoundItem.create({
      type,
      item,
      description,
      location,
      contact,
      imageUrl: req.file?.path || "",
      cloudinaryPublicId: req.file?.filename || "",
      postedBy: req.user._id,
      approved: true,
      approvedBy: req.user._id,
      approvedAt: Date.now(),
    });

    await lostFoundItem.populate("postedBy", "name email studentId");

    broadcastNotification(req.io, {
      excludeUser: req.user._id,
      title: `${lostFoundItem.type === "lost" ? "Lost" : "Found"} item posted`,
      message: `${req.user.name} posted "${lostFoundItem.item}" (${lostFoundItem.type}) — ${lostFoundItem.location}.`,
      type: "lost-found",
      sender: req.user._id,
      link: `/lost-found?highlight=${lostFoundItem._id}`,
      metadata: { itemId: lostFoundItem._id },
    });
    req.io?.emit("lostfound:new", lostFoundItem);

    res.status(201).json({
      success: true,
      message: "Item posted successfully",
      item: lostFoundItem,
    });
  } catch (error) {
    if (req.file?.filename) {
      try {
        await cloudinary.uploader.destroy(req.file.filename);
      } catch (deleteError) {
        console.error("Lost found image cleanup error:", deleteError);
      }
    }

    console.error("Create lost found item error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating item",
    });
  }
};

exports.getItems = async (req, res) => {
  try {
    const { type, status, approved, mine, search } = req.query;
    const query = {};

    if (mine === "true" && req.user) {
      query.postedBy = req.user._id;
    } else if (canModerate(req.user)) {
      // admin/moderator: apply filter only if explicitly provided, else see all
      if (approved !== undefined) query.approved = approved === "true";
    } else {
      query.approved = true;
    }

    if (type && type !== "all") query.type = type;
    if (status && status !== "all") query.status = status;
    if (search) {
      query.$or = [
        { item: new RegExp(search, "i") },
        { description: new RegExp(search, "i") },
        { location: new RegExp(search, "i") },
      ];
    }

    const items = await LostFoundItem.find(query)
      .populate("postedBy", "name email studentId")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: items.length,
      items,
    });
  } catch (error) {
    console.error("Get lost found items error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching items",
    });
  }
};

exports.updateItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);

    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    const isOwner = item.postedBy.toString() === req.user._id.toString();
    if (!isOwner && !canModerate(req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { item: newItemName, description: newDescription, location: newLocation, contact: newContact } = req.body;
    if (newItemName || newDescription || newLocation || newContact || req.file) {
      const rejection = await moderatePost({
        texts: [newItemName, newDescription, newLocation, newContact],
        imageUrls: req.file?.path ? [req.file.path] : [],
      });
      if (rejection) {
        if (req.file?.filename) {
          try {
            await cloudinary.uploader.destroy(req.file.filename);
          } catch (deleteError) {
            console.error("Flagged lost found image cleanup error:", deleteError);
          }
        }
        return res.status(422).json({
          success: false,
          code: "CONTENT_REJECTED",
          message: rejection.message,
          categories: rejection.categories,
        });
      }
    }

    const previousStatus = item.status;
    const allowedFields = ["type", "item", "description", "location", "contact", "status"];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) item[field] = req.body[field];
    });

    if (req.file) {
      if (item.cloudinaryPublicId) {
        try {
          await cloudinary.uploader.destroy(item.cloudinaryPublicId);
        } catch (deleteError) {
          console.error("Old lost found image delete error:", deleteError);
        }
      }
      item.imageUrl = req.file.path;
      item.cloudinaryPublicId = req.file.filename;
    }

    if (isOwner && !canModerate(req.user)) {
      item.approved = false;
      item.rejectionReason = "";
      item.approvedBy = undefined;
      item.approvedAt = undefined;
    }

    await item.save();
    await item.populate("postedBy", "name email studentId");

    // Status change is campus-wide news (e.g. a lost wallet got claimed) —
    // notify everyone and refresh open Lost & Found pages live.
    if (item.status !== previousStatus && item.approved) {
      broadcastNotification(req.io, {
        excludeUser: req.user._id,
        title: `Lost & Found: ${item.item}`,
        message: `"${item.item}" (${item.type}) is now ${statusLabels[item.status] || item.status}.`,
        type: "lost-found",
        sender: req.user._id,
        link: `/lost-found?highlight=${item._id}`,
        metadata: { itemId: item._id, status: item.status },
      });
    }
    req.io?.emit("lostfound:updated", item);

    res.status(200).json({
      success: true,
      message: item.approved ? "Item updated" : "Item updated and sent for approval",
      item,
    });
  } catch (error) {
    console.error("Update lost found item error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error updating item",
    });
  }
};

exports.deleteItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);

    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    const isOwner = item.postedBy.toString() === req.user._id.toString();
    if (!isOwner && !canModerate(req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    if (item.cloudinaryPublicId) {
      try {
        await cloudinary.uploader.destroy(item.cloudinaryPublicId);
      } catch (deleteError) {
        console.error("Lost found image delete error:", deleteError);
      }
    }

    await item.deleteOne();

    res.status(200).json({ success: true, message: "Item deleted" });
  } catch (error) {
    console.error("Delete lost found item error:", error);
    res.status(500).json({ success: false, message: "Error deleting item" });
  }
};

exports.approveItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);

    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    item.approved = true;
    item.approvedBy = req.user._id;
    item.approvedAt = Date.now();
    item.rejectionReason = "";
    await item.save();

    await sendNotification(req.io, {
      user: item.postedBy,
      title: "Lost & Found item approved",
      message: `"${item.item}" is now visible on Lost & Found.`,
      type: "lost-found",
      link: `/lost-found?highlight=${item._id}`,
    });
    req.io?.emit("lostfound:updated", item);

    res.status(200).json({ success: true, message: "Item approved", item });
  } catch (error) {
    console.error("Approve lost found item error:", error);
    res.status(500).json({ success: false, message: "Error approving item" });
  }
};

exports.rejectItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);

    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    item.approved = false;
    item.rejectionReason = req.body.reason || "Does not meet posting standards";
    await item.save();

    await sendNotification(req.io, {
      user: item.postedBy,
      title: "Lost & Found item rejected",
      message: `"${item.item}" needs revision. Reason: ${item.rejectionReason}`,
      type: "lost-found",
      link: "/lost-found",
    });

    res.status(200).json({ success: true, message: "Item rejected", item });
  } catch (error) {
    console.error("Reject lost found item error:", error);
    res.status(500).json({ success: false, message: "Error rejecting item" });
  }
};
