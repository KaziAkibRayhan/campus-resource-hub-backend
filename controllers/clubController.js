const Club = require("../models/Club");
const Event = require("../models/Event");
const {
  broadcastNotification,
  sendNotification,
} = require("../utils/notificationHelper");
const { moderatePost } = require("../utils/postModeration");
const { semanticPaginatedFind } = require("../utils/semanticSearch");

const canModerate = (user) => user && ["admin", "moderator"].includes(user.role);

const idOf = (ref) =>
  ref && (ref._id ? ref._id.toString() : ref.toString ? ref.toString() : "");

// Officer-level powers: site moderators, the creator, or a member with the
// "officer" role.
const canManageClub = (club, user) => {
  if (!user) return false;
  if (canModerate(user)) return true;
  if (idOf(club.createdBy) === user._id.toString()) return true;
  return club.members.some(
    (m) => idOf(m.user) === user._id.toString() && m.role === "officer"
  );
};

const shapeClub = (club, user) => {
  const obj = club.toObject ? club.toObject() : { ...club };
  const uid = user?._id?.toString();
  const myMembership = uid
    ? (obj.members || []).find((m) => idOf(m.user) === uid)
    : null;

  obj.memberCount = (obj.members || []).length;
  obj.isMember = !!myMembership;
  obj.myRole = myMembership ? myMembership.role : null;
  obj.isOfficer = canManageClub(obj, user);
  obj.isOwner = uid && idOf(obj.createdBy) === uid;
  obj.hasRequested = uid
    ? (obj.joinRequests || []).some((r) => idOf(r.user) === uid)
    : false;
  obj.pendingRequestCount = (obj.joinRequests || []).length;

  // Only officers see the join-request queue.
  if (!obj.isOfficer) delete obj.joinRequests;
  return obj;
};

// @route GET /api/clubs
exports.getClubs = async (req, res) => {
  try {
    const { search, category, page = 1, limit = 12 } = req.query;
    const query = { approved: true };

    if (category && category !== "all") query.category = category;

    const perPage = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 50);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);

    if (search) {
      // Semantic search first (relevance-ranked, keyword matches kept on
      // top); legacy regex when the embedding model is unavailable.
      const regexOr = [
        { name: new RegExp(search, "i") },
        { description: new RegExp(search, "i") },
        { category: new RegExp(search, "i") },
      ];

      const semanticResult = await semanticPaginatedFind(Club, {
        type: "club",
        search,
        baseQuery: query,
        regexOr,
        page: pageNum,
        limit: perPage,
        populate: [
          ["createdBy", "name email"],
          ["joinRequests.user", "name email studentId"],
        ],
      });

      if (semanticResult) {
        const categories = await Club.distinct("category", { approved: true });
        return res.status(200).json({
          success: true,
          count: semanticResult.docs.length,
          total: semanticResult.total,
          totalPages: Math.ceil(semanticResult.total / perPage),
          currentPage: pageNum,
          categories: categories.filter(Boolean).sort(),
          clubs: semanticResult.docs.map((c) => shapeClub(c, req.user)),
          semantic: true,
        });
      }

      query.$or = regexOr;
    }

    const [clubs, total, categories] = await Promise.all([
      Club.find(query)
        .populate("createdBy", "name email")
        .populate("joinRequests.user", "name email studentId")
        .sort({ name: 1 })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      Club.countDocuments(query),
      Club.distinct("category", { approved: true }),
    ]);

    res.status(200).json({
      success: true,
      count: clubs.length,
      total,
      totalPages: Math.ceil(total / perPage),
      currentPage: pageNum,
      categories: categories.filter(Boolean).sort(),
      clubs: clubs.map((c) => shapeClub(c, req.user)),
    });
  } catch (error) {
    console.error("Get clubs error:", error);
    res.status(500).json({ success: false, message: "Error fetching clubs" });
  }
};

// @route GET /api/clubs/:id  — club page (members + upcoming events)
exports.getClubById = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("members.user", "name email studentId")
      .populate("joinRequests.user", "name email studentId");
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }

    const events = await Event.find({
      clubRef: club._id,
      approved: true,
      status: "scheduled",
      date: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    })
      .sort("date")
      .limit(20)
      .lean();

    const shaped = shapeClub(club, req.user);
    // Officers/members see the roster; outsiders just see counts.
    if (!shaped.isOfficer && !shaped.isMember) delete shaped.members;

    res.status(200).json({ success: true, club: shaped, events });
  } catch (error) {
    console.error("Get club error:", error);
    res.status(500).json({ success: false, message: "Error fetching club" });
  }
};

// @route POST /api/clubs
exports.createClub = async (req, res) => {
  try {
    const { name, description, category, joinPolicy } = req.body;

    const rejection = await moderatePost({ texts: [name, description, category] });
    if (rejection) {
      return res.status(422).json({
        success: false,
        code: "CONTENT_REJECTED",
        message: rejection.message,
        categories: rejection.categories,
      });
    }

    const club = await Club.create({
      name,
      description,
      category: category || "General",
      joinPolicy: joinPolicy === "request" ? "request" : "open",
      createdBy: req.user._id,
      members: [{ user: req.user._id, role: "officer" }],
      approved: true,
    });

    broadcastNotification(req.io, {
      excludeUser: req.user._id,
      title: "New club",
      message: `"${club.name}" (${club.category || "General"}) is now open — join from the Clubs page.`,
      type: "system",
      sender: req.user._id,
      link: `/clubs?highlight=${club._id}`,
      metadata: { clubId: club._id },
    });
    req.io?.emit("club:new", shapeClub(club, null));

    res.status(201).json({
      success: true,
      message: "Club created successfully",
      club: shapeClub(club, req.user),
    });
  } catch (error) {
    console.error("Create club error:", error);
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "A club with this name already exists" });
    }
    res.status(500).json({
      success: false,
      message: error.message || "Error creating club",
    });
  }
};

// @route PUT /api/clubs/:id
exports.updateClub = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }
    if (!canManageClub(club, req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { name, description, category, joinPolicy } = req.body;
    if (name || description || category) {
      const rejection = await moderatePost({ texts: [name, description, category] });
      if (rejection) {
        return res.status(422).json({
          success: false,
          code: "CONTENT_REJECTED",
          message: rejection.message,
          categories: rejection.categories,
        });
      }
    }

    if (name) club.name = name;
    if (description) club.description = description;
    if (category) club.category = category;
    if (joinPolicy) club.joinPolicy = joinPolicy === "request" ? "request" : "open";
    await club.save();

    req.io?.emit("club:updated", { clubId: club._id, ...shapeClub(club, null) });

    res.status(200).json({
      success: true,
      message: "Club updated",
      club: shapeClub(club, req.user),
    });
  } catch (error) {
    console.error("Update club error:", error);
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "A club with this name already exists" });
    }
    res.status(500).json({ success: false, message: "Error updating club" });
  }
};

// @route POST /api/clubs/:id/join
exports.joinClub = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }

    const uid = req.user._id.toString();
    if (club.members.some((m) => idOf(m.user) === uid)) {
      return res.status(400).json({ success: false, message: "Already a member" });
    }

    // Request-to-join clubs queue the user for officer approval.
    if (club.joinPolicy === "request") {
      if (club.joinRequests.some((r) => idOf(r.user) === uid)) {
        return res
          .status(400)
          .json({ success: false, message: "Request already pending" });
      }
      club.joinRequests.push({
        user: req.user._id,
        note: (req.body.note || "").slice(0, 300),
      });
      await club.save();

      // Notify the club's officers.
      const officers = club.members
        .filter((m) => m.role === "officer")
        .map((m) => idOf(m.user));
      await Promise.all(
        officers.map((officerId) =>
          sendNotification(req.io, {
            user: officerId,
            title: "New join request",
            message: `${req.user.name} requested to join "${club.name}".`,
            type: "system",
            sender: req.user._id,
            link: `/clubs?highlight=${club._id}`,
            metadata: { clubId: club._id },
          })
        )
      );
      req.io?.emit("club:updated", {
        clubId: club._id,
        pendingRequestCount: club.joinRequests.length,
      });

      return res.status(202).json({
        success: true,
        message: "Request sent — an officer will review it.",
        club: shapeClub(club, req.user),
      });
    }

    club.members.push({ user: req.user._id, role: "member" });
    await club.save();

    broadcastNotification(req.io, {
      excludeUser: req.user._id,
      title: "New club member",
      message: `${req.user.name} joined "${club.name}" — ${club.members.length} members now.`,
      type: "system",
      sender: req.user._id,
      link: `/clubs?highlight=${club._id}`,
      metadata: { clubId: club._id },
    });
    req.io?.emit("club:updated", {
      clubId: club._id,
      memberCount: club.members.length,
    });

    res
      .status(200)
      .json({ success: true, message: "Joined club", club: shapeClub(club, req.user) });
  } catch (error) {
    console.error("Join club error:", error);
    res.status(500).json({ success: false, message: "Error joining club" });
  }
};

// @route DELETE /api/clubs/:id/leave
exports.leaveClub = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }
    if (idOf(club.createdBy) === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: "The club creator can't leave. Delete the club instead.",
      });
    }

    club.members = club.members.filter(
      (m) => idOf(m.user) !== req.user._id.toString()
    );
    await club.save();

    req.io?.emit("club:updated", {
      clubId: club._id,
      memberCount: club.members.length,
    });

    res
      .status(200)
      .json({ success: true, message: "Left club", club: shapeClub(club, req.user) });
  } catch (error) {
    console.error("Leave club error:", error);
    res.status(500).json({ success: false, message: "Error leaving club" });
  }
};

// @route PUT /api/clubs/:id/requests/:userId  { decision }
exports.decideRequest = async (req, res) => {
  try {
    const { decision } = req.body; // "approve" | "reject"
    const club = await Club.findById(req.params.id);
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }
    if (!canManageClub(club, req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const reqIndex = club.joinRequests.findIndex(
      (r) => idOf(r.user) === req.params.userId
    );
    if (reqIndex === -1) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    const [request] = club.joinRequests.splice(reqIndex, 1);

    if (decision === "approve") {
      if (!club.members.some((m) => idOf(m.user) === req.params.userId)) {
        club.members.push({ user: request.user, role: "member" });
      }
      await club.save();
      await sendNotification(req.io, {
        user: request.user,
        title: "Join request approved",
        message: `You're now a member of "${club.name}".`,
        type: "system",
        sender: req.user._id,
        link: `/clubs?highlight=${club._id}`,
        metadata: { clubId: club._id },
      });
    } else {
      await club.save();
      await sendNotification(req.io, {
        user: request.user,
        title: "Join request declined",
        message: `Your request to join "${club.name}" was declined.`,
        type: "system",
        sender: req.user._id,
        link: `/clubs?highlight=${club._id}`,
        metadata: { clubId: club._id },
      });
    }

    await club.populate("members.user", "name email studentId");
    await club.populate("joinRequests.user", "name email studentId");
    req.io?.emit("club:updated", {
      clubId: club._id,
      memberCount: club.members.length,
      pendingRequestCount: club.joinRequests.length,
    });

    res.status(200).json({
      success: true,
      message: decision === "approve" ? "Member added" : "Request declined",
      club: shapeClub(club, req.user),
    });
  } catch (error) {
    console.error("Decide request error:", error);
    res.status(500).json({ success: false, message: "Error updating request" });
  }
};

// @route PUT /api/clubs/:id/members/:userId/role  { role }
exports.setMemberRole = async (req, res) => {
  try {
    const { role } = req.body; // "officer" | "member"
    if (!["officer", "member"].includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }
    const club = await Club.findById(req.params.id);
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }
    if (!canManageClub(club, req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (idOf(club.createdBy) === req.params.userId) {
      return res
        .status(400)
        .json({ success: false, message: "The creator's role can't be changed" });
    }

    const member = club.members.find((m) => idOf(m.user) === req.params.userId);
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }
    member.role = role;
    await club.save();

    await sendNotification(req.io, {
      user: member.user,
      title: role === "officer" ? "You're now an officer" : "Role updated",
      message: `Your role in "${club.name}" is now ${role}.`,
      type: "system",
      sender: req.user._id,
      link: `/clubs?highlight=${club._id}`,
      metadata: { clubId: club._id },
    });

    await club.populate("members.user", "name email studentId");
    res.status(200).json({
      success: true,
      message: "Role updated",
      club: shapeClub(club, req.user),
    });
  } catch (error) {
    console.error("Set member role error:", error);
    res.status(500).json({ success: false, message: "Error updating role" });
  }
};

// @route DELETE /api/clubs/:id/members/:userId
exports.removeMember = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }
    if (!canManageClub(club, req.user)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (idOf(club.createdBy) === req.params.userId) {
      return res
        .status(400)
        .json({ success: false, message: "The creator can't be removed" });
    }

    club.members = club.members.filter((m) => idOf(m.user) !== req.params.userId);
    await club.save();
    await club.populate("members.user", "name email studentId");

    req.io?.emit("club:updated", {
      clubId: club._id,
      memberCount: club.members.length,
    });

    res.status(200).json({
      success: true,
      message: "Member removed",
      club: shapeClub(club, req.user),
    });
  } catch (error) {
    console.error("Remove member error:", error);
    res.status(500).json({ success: false, message: "Error removing member" });
  }
};

// @route DELETE /api/clubs/:id
exports.deleteClub = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }
    if (!canModerate(req.user) && idOf(club.createdBy) !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    await club.deleteOne();
    req.io?.emit("club:deleted", { _id: club._id });
    res.status(200).json({ success: true, message: "Club deleted" });
  } catch (error) {
    console.error("Delete club error:", error);
    res.status(500).json({ success: false, message: "Error deleting club" });
  }
};
