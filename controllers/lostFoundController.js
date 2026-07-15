const LostFoundItem = require("../models/LostFoundItem");
const cloudinary = require("../config/cloudinary");
const {
  sendNotification,
  broadcastNotification,
  notifyModerators,
} = require("../utils/notificationHelper");
const { screenPost } = require("../utils/postModeration");
const { semanticPaginatedFind } = require("../utils/semanticSearch");

const statusLabels = {
  open: "open again",
  claimed: "claimed",
  resolved: "resolved",
};

const canModerate = (user) => user && ["admin", "moderator"].includes(user.role);

const idOf = (ref) =>
  ref && (ref._id ? ref._id.toString() : ref.toString ? ref.toString() : "");

const destroyImage = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (deleteError) {
    console.error("Lost found image cleanup error:", deleteError);
  }
};

// Shape an item for the requesting user: hide private contact info and other
// users' claims unless they're the poster, an approved claimant, or a moderator.
const shapeItem = (raw, user) => {
  const obj = raw.toObject ? raw.toObject() : { ...raw };
  const uid = user?._id?.toString();
  const isOwner = uid && idOf(obj.postedBy) === uid;
  const isClaimer = uid && obj.claimedBy && idOf(obj.claimedBy) === uid;
  const moderator = canModerate(user);

  const contactVisible =
    obj.contactVisibility === "public" || isOwner || isClaimer || moderator;
  if (!contactVisible) {
    delete obj.contact;
    obj.contactLocked = true;
  }

  const claims = obj.claims || [];
  obj.pendingClaimCount = claims.filter((c) => c.status === "pending").length;
  obj.myClaim = uid
    ? claims
        .filter((c) => idOf(c.user) === uid)
        .map((c) => ({ status: c.status, note: c.note, createdAt: c.createdAt }))[0] ||
      null
    : null;

  if (!(isOwner || moderator)) {
    // Non-owners never see who else claimed an item.
    delete obj.claims;
  }
  return obj;
};

// @route POST /api/lost-found
exports.createItem = async (req, res) => {
  try {
    const { type, item, description, location, contact, contactVisibility } =
      req.body;

    const verdict = await screenPost({
      texts: [item, description, location, contact],
      imageUrls: req.file?.path ? [req.file.path] : [],
    });

    // CSAM is illegal to store — always hard-rejected, never published.
    if (verdict.isCSAM) {
      await destroyImage(req.file?.filename);
      return res.status(422).json({
        success: false,
        code: "CONTENT_REJECTED",
        message:
          "Upload blocked: this appears to contain sexual content involving minors. It violates community guidelines and was not posted.",
        categories: verdict.categories,
      });
    }

    // Anything else that's flagged — or that couldn't be auto-checked — is held
    // unpublished for an admin/moderator to review instead of being blocked.
    const heldForReview = verdict.flagged || verdict.status !== "checked";

    const lostFoundItem = await LostFoundItem.create({
      type,
      item,
      description,
      location,
      contact,
      contactVisibility:
        contactVisibility === "public" ? "public" : "on-request",
      imageUrl: req.file?.path || "",
      cloudinaryPublicId: req.file?.filename || "",
      postedBy: req.user._id,
      approved: !heldForReview,
      approvedBy: heldForReview ? undefined : req.user._id,
      approvedAt: heldForReview ? undefined : Date.now(),
      moderation: {
        status: verdict.status === "checked" ? "approved" : "skipped",
        flagged: heldForReview,
        categories: verdict.flagged ? verdict.categories : [],
        provider: verdict.provider || undefined,
        checkedAt: new Date(),
      },
    });

    await lostFoundItem.populate("postedBy", "name email studentId");

    if (heldForReview) {
      const reason = verdict.flagged
        ? `was flagged for ${verdict.describe}`
        : "could not be automatically safety-checked";
      await notifyModerators(req.io, {
        title: "Lost & Found post needs review",
        message: `${req.user.name}'s post "${lostFoundItem.item}" ${reason} and is awaiting review.`,
        type: "lost-found",
        sender: req.user._id,
        link: `/admin?tab=review`,
        metadata: { itemId: lostFoundItem._id },
      });

      return res.status(201).json({
        success: true,
        code: "UNDER_REVIEW",
        message:
          "Your post was submitted and is under review. It will appear once a moderator approves it.",
        item: shapeItem(lostFoundItem, req.user),
      });
    }

    broadcastNotification(req.io, {
      excludeUser: req.user._id,
      title: `${lostFoundItem.type === "lost" ? "Lost" : "Found"} item posted`,
      message: `${req.user.name} posted "${lostFoundItem.item}" (${lostFoundItem.type}) — ${lostFoundItem.location}.`,
      type: "lost-found",
      sender: req.user._id,
      link: `/lost-found?highlight=${lostFoundItem._id}`,
      metadata: { itemId: lostFoundItem._id },
    });
    req.io?.emit("lostfound:new", shapeItem(lostFoundItem, null));

    res.status(201).json({
      success: true,
      message: "Item posted successfully",
      item: shapeItem(lostFoundItem, req.user),
    });
  } catch (error) {
    await destroyImage(req.file?.filename);
    console.error("Create lost found item error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating item",
    });
  }
};

// @route GET /api/lost-found
exports.getItems = async (req, res) => {
  try {
    const {
      type,
      status,
      approved,
      mine,
      search,
      pending,
      page = 1,
      limit = 12,
    } = req.query;
    const query = {};
    const moderator = canModerate(req.user);

    if (pending === "true" && moderator) {
      // Review queue: held-for-review items awaiting a decision.
      query.approved = false;
      query.$or = [
        { rejectionReason: { $exists: false } },
        { rejectionReason: null },
        { rejectionReason: "" },
      ];
    } else if (mine === "true" && req.user) {
      query.postedBy = req.user._id;
    } else if (moderator) {
      if (approved !== undefined) query.approved = approved === "true";
    } else {
      query.approved = true;
    }

    if (type && type !== "all") query.type = type;
    if (status && status !== "all") query.status = status;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 50);

    if (search) {
      const searchOr = [
        { item: new RegExp(search, "i") },
        { description: new RegExp(search, "i") },
        { location: new RegExp(search, "i") },
      ];

      // Semantic search first (relevance-ranked, keyword matches kept on
      // top); legacy regex when the embedding model is unavailable.
      // baseQuery is the query BEFORE the search $or merge, so the review
      // queue's rejectionReason $or stays intact as a visibility filter.
      const semanticResult = await semanticPaginatedFind(LostFoundItem, {
        type: "lost-found",
        search,
        baseQuery: { ...query },
        regexOr: searchOr,
        page: pageNum,
        limit: perPage,
        populate: [
          ["postedBy", "name email studentId"],
          ["claimedBy", "name email studentId"],
          ["claims.user", "name email studentId"],
        ],
      });

      if (semanticResult) {
        return res.status(200).json({
          success: true,
          count: semanticResult.docs.length,
          total: semanticResult.total,
          totalPages: Math.ceil(semanticResult.total / perPage),
          currentPage: pageNum,
          items: semanticResult.docs.map((it) => shapeItem(it, req.user)),
          semantic: true,
        });
      }

      if (query.$or) query.$and = [{ $or: query.$or }, { $or: searchOr }];
      else query.$or = searchOr;
    }

    const skip = (pageNum - 1) * perPage;

    const [items, total] = await Promise.all([
      LostFoundItem.find(query)
        .populate("postedBy", "name email studentId")
        .populate("claimedBy", "name email studentId")
        .populate("claims.user", "name email studentId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      LostFoundItem.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      count: items.length,
      total,
      totalPages: Math.ceil(total / perPage),
      currentPage: pageNum,
      items: items.map((it) => shapeItem(it, req.user)),
    });
  } catch (error) {
    console.error("Get lost found items error:", error);
    res.status(500).json({ success: false, message: "Error fetching items" });
  }
};

// @route PUT /api/lost-found/:id
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

    const {
      item: newItemName,
      description: newDescription,
      location: newLocation,
      contact: newContact,
    } = req.body;

    if (newItemName || newDescription || newLocation || newContact || req.file) {
      const verdict = await screenPost({
        texts: [newItemName, newDescription, newLocation, newContact],
        imageUrls: req.file?.path ? [req.file.path] : [],
      });
      if (verdict.isCSAM) {
        await destroyImage(req.file?.filename);
        return res.status(422).json({
          success: false,
          code: "CONTENT_REJECTED",
          message:
            "Update blocked: this appears to contain sexual content involving minors.",
          categories: verdict.categories,
        });
      }
      // An edit that introduces flagged/unscannable content is held for review.
      if (verdict.flagged || verdict.status !== "checked") {
        item.approved = false;
        item.approvedBy = undefined;
        item.approvedAt = undefined;
        item.moderation = {
          status: verdict.status === "checked" ? "approved" : "skipped",
          flagged: true,
          categories: verdict.flagged ? verdict.categories : [],
          provider: verdict.provider || undefined,
          checkedAt: new Date(),
        };
      } else if (isOwner && !canModerate(req.user)) {
        // Clean owner edit still re-enters the normal approval flow.
        item.approved = true;
        item.approvedBy = req.user._id;
        item.approvedAt = Date.now();
        item.rejectionReason = "";
        item.moderation = {
          status: "approved",
          flagged: false,
          categories: [],
          provider: verdict.provider || undefined,
          checkedAt: new Date(),
        };
      }
    }

    const editable = ["type", "item", "description", "location", "contact"];
    editable.forEach((field) => {
      if (req.body[field] !== undefined) item[field] = req.body[field];
    });
    if (req.body.contactVisibility !== undefined) {
      item.contactVisibility =
        req.body.contactVisibility === "public" ? "public" : "on-request";
    }

    if (req.file) {
      await destroyImage(item.cloudinaryPublicId);
      item.imageUrl = req.file.path;
      item.cloudinaryPublicId = req.file.filename;
    }

    await item.save();
    await item.populate("postedBy", "name email studentId");
    await item.populate("claimedBy", "name email studentId");

    req.io?.emit("lostfound:updated", shapeItem(item, null));

    res.status(200).json({
      success: true,
      message: item.approved
        ? "Item updated"
        : "Item updated and sent for review",
      item: shapeItem(item, req.user),
    });
  } catch (error) {
    console.error("Update lost found item error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error updating item",
    });
  }
};

// @route DELETE /api/lost-found/:id
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

    await destroyImage(item.cloudinaryPublicId);
    await item.deleteOne();
    req.io?.emit("lostfound:deleted", { _id: item._id });

    res.status(200).json({ success: true, message: "Item deleted" });
  } catch (error) {
    console.error("Delete lost found item error:", error);
    res.status(500).json({ success: false, message: "Error deleting item" });
  }
};

// @route POST /api/lost-found/:id/claims  — file a claim on an item
exports.claimItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);
    if (!item || !item.approved) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    if (item.postedBy.toString() === req.user._id.toString()) {
      return res
        .status(400)
        .json({ success: false, message: "You can't claim your own post" });
    }
    if (item.status !== "open") {
      return res.status(400).json({
        success: false,
        message: `This item is already ${item.status}.`,
      });
    }
    const existing = item.claims.find(
      (c) =>
        c.user.toString() === req.user._id.toString() && c.status !== "rejected"
    );
    if (existing) {
      return res
        .status(400)
        .json({ success: false, message: "You already have an active claim" });
    }

    item.claims.push({
      user: req.user._id,
      note: (req.body.note || "").slice(0, 300),
      status: "pending",
    });
    await item.save();

    await sendNotification(req.io, {
      user: item.postedBy,
      title: "New claim on your post",
      message: `${req.user.name} claimed "${item.item}". Review and approve if it's a match.`,
      type: "lost-found",
      sender: req.user._id,
      link: `/lost-found?highlight=${item._id}`,
      metadata: { itemId: item._id },
    });

    await item.populate("postedBy", "name email studentId");
    await item.populate("claims.user", "name email studentId");
    req.io?.emit("lostfound:updated", shapeItem(item, null));

    res.status(201).json({
      success: true,
      message: "Claim submitted. The poster will be notified.",
      item: shapeItem(item, req.user),
    });
  } catch (error) {
    console.error("Claim lost found item error:", error);
    res.status(500).json({ success: false, message: "Error submitting claim" });
  }
};

// @route PUT /api/lost-found/:id/claims/:claimId  — owner/mod decides a claim
exports.decideClaim = async (req, res) => {
  try {
    const { decision } = req.body; // "approve" | "reject"
    const item = await LostFoundItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    const isOwner = item.postedBy.toString() === req.user._id.toString();
    if (!isOwner && !canModerate(req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const claim = item.claims.id(req.params.claimId);
    if (!claim || claim.status !== "pending") {
      return res
        .status(404)
        .json({ success: false, message: "Pending claim not found" });
    }

    if (decision === "approve") {
      claim.status = "approved";
      claim.decidedAt = new Date();
      item.status = "claimed";
      item.claimedBy = claim.user;
      item.claimedAt = new Date();
      // Auto-reject the other pending claims for this now-claimed item.
      item.claims.forEach((c) => {
        if (c.status === "pending" && c._id.toString() !== claim._id.toString()) {
          c.status = "rejected";
          c.decidedAt = new Date();
        }
      });
      await item.save();

      await sendNotification(req.io, {
        user: claim.user,
        title: "Your claim was approved",
        message: `Your claim on "${item.item}" was approved. Contact details are now visible.`,
        type: "lost-found",
        sender: req.user._id,
        link: `/lost-found?highlight=${item._id}`,
        metadata: { itemId: item._id, status: "claimed" },
      });
    } else {
      claim.status = "rejected";
      claim.decidedAt = new Date();
      await item.save();

      await sendNotification(req.io, {
        user: claim.user,
        title: "Your claim was declined",
        message: `Your claim on "${item.item}" was not approved.`,
        type: "lost-found",
        sender: req.user._id,
        link: `/lost-found?highlight=${item._id}`,
        metadata: { itemId: item._id },
      });
    }

    await item.populate("postedBy", "name email studentId");
    await item.populate("claimedBy", "name email studentId");
    await item.populate("claims.user", "name email studentId");
    req.io?.emit("lostfound:updated", shapeItem(item, null));

    res.status(200).json({
      success: true,
      message: decision === "approve" ? "Claim approved" : "Claim declined",
      item: shapeItem(item, req.user),
    });
  } catch (error) {
    console.error("Decide claim error:", error);
    res.status(500).json({ success: false, message: "Error updating claim" });
  }
};

// @route PUT /api/lost-found/:id/resolve  — close out an item
exports.resolveItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    const isOwner = item.postedBy.toString() === req.user._id.toString();
    if (!isOwner && !canModerate(req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    item.status = "resolved";
    item.resolvedAt = new Date();
    await item.save();

    await item.populate("postedBy", "name email studentId");
    await item.populate("claimedBy", "name email studentId");

    broadcastNotification(req.io, {
      excludeUser: req.user._id,
      title: `Lost & Found: ${item.item}`,
      message: `"${item.item}" (${item.type}) is now ${statusLabels.resolved}.`,
      type: "lost-found",
      sender: req.user._id,
      link: `/lost-found?highlight=${item._id}`,
      metadata: { itemId: item._id, status: "resolved" },
    });
    req.io?.emit("lostfound:updated", shapeItem(item, null));

    res.status(200).json({
      success: true,
      message: "Item marked as resolved",
      item: shapeItem(item, req.user),
    });
  } catch (error) {
    console.error("Resolve lost found item error:", error);
    res.status(500).json({ success: false, message: "Error resolving item" });
  }
};

// @route PUT /api/lost-found/:id/reopen  — undo claim/resolve
exports.reopenItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    const isOwner = item.postedBy.toString() === req.user._id.toString();
    if (!isOwner && !canModerate(req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    item.status = "open";
    item.claimedBy = undefined;
    item.claimedAt = undefined;
    item.resolvedAt = undefined;
    await item.save();

    await item.populate("postedBy", "name email studentId");
    req.io?.emit("lostfound:updated", shapeItem(item, null));

    res.status(200).json({
      success: true,
      message: "Item reopened",
      item: shapeItem(item, req.user),
    });
  } catch (error) {
    console.error("Reopen lost found item error:", error);
    res.status(500).json({ success: false, message: "Error reopening item" });
  }
};

// @route PUT /api/lost-found/:id/approve  — moderator publishes a held post
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
    if (item.moderation) item.moderation.flagged = false;
    await item.save();

    await item.populate("postedBy", "name email studentId");

    await sendNotification(req.io, {
      user: item.postedBy,
      title: "Lost & Found item approved",
      message: `"${item.item}" is now visible on Lost & Found.`,
      type: "lost-found",
      link: `/lost-found?highlight=${item._id}`,
    });
    broadcastNotification(req.io, {
      excludeUser: idOf(item.postedBy),
      title: `${item.type === "lost" ? "Lost" : "Found"} item posted`,
      message: `"${item.item}" (${item.type}) — ${item.location}.`,
      type: "lost-found",
      sender: idOf(item.postedBy),
      link: `/lost-found?highlight=${item._id}`,
      metadata: { itemId: item._id },
    });
    req.io?.emit("lostfound:updated", shapeItem(item, null));

    res
      .status(200)
      .json({ success: true, message: "Item approved", item: shapeItem(item, req.user) });
  } catch (error) {
    console.error("Approve lost found item error:", error);
    res.status(500).json({ success: false, message: "Error approving item" });
  }
};

// @route PUT /api/lost-found/:id/reject
exports.rejectItem = async (req, res) => {
  try {
    const item = await LostFoundItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    item.approved = false;
    item.rejectionReason = req.body.reason || "Does not meet posting standards";
    if (item.moderation) item.moderation.flagged = false;
    await item.save();

    await sendNotification(req.io, {
      user: item.postedBy,
      title: "Lost & Found item rejected",
      message: `"${item.item}" needs revision. Reason: ${item.rejectionReason}`,
      type: "lost-found",
      link: "/lost-found",
    });

    res
      .status(200)
      .json({ success: true, message: "Item rejected", item });
  } catch (error) {
    console.error("Reject lost found item error:", error);
    res.status(500).json({ success: false, message: "Error rejecting item" });
  }
};
