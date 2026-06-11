const Club = require("../models/Club");
const { broadcastNotification } = require("../utils/notificationHelper");
const { moderatePost } = require("../utils/postModeration");

const canModerate = (user) => user && ["admin", "moderator"].includes(user.role);

exports.getClubs = async (req, res) => {
  try {
    const { search } = req.query;
    const query = { approved: true };

    if (search) {
      query.$or = [
        { name: new RegExp(search, "i") },
        { description: new RegExp(search, "i") },
        { category: new RegExp(search, "i") },
      ];
    }

    const clubs = await Club.find(query)
      .populate("createdBy", "name email")
      .sort({ name: 1 })
      .lean();

    const currentUserId = req.user?._id?.toString();
    const shapedClubs = clubs.map((club) => ({
      ...club,
      memberCount: club.members.length,
      isMember: currentUserId
        ? club.members.some((member) => member.user.toString() === currentUserId)
        : false,
    }));

    res.status(200).json({
      success: true,
      count: shapedClubs.length,
      clubs: shapedClubs,
    });
  } catch (error) {
    console.error("Get clubs error:", error);
    res.status(500).json({ success: false, message: "Error fetching clubs" });
  }
};

exports.createClub = async (req, res) => {
  try {
    const { name, description, category } = req.body;

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
      category,
      createdBy: req.user._id,
      moderators: [req.user._id],
      members: [{ user: req.user._id }],
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
    req.io?.emit("club:new", club);

    res.status(201).json({
      success: true,
      message: "Club created successfully",
      club,
    });
  } catch (error) {
    console.error("Create club error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating club",
    });
  }
};

exports.joinClub = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);

    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }

    const alreadyMember = club.members.some(
      (member) => member.user.toString() === req.user._id.toString()
    );

    if (!alreadyMember) {
      club.members.push({ user: req.user._id });
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

      // Live-update member counts on open Clubs pages
      req.io?.emit("club:updated", {
        clubId: club._id,
        memberCount: club.members.length,
      });
    }

    res.status(200).json({ success: true, message: "Joined club", club });
  } catch (error) {
    console.error("Join club error:", error);
    res.status(500).json({ success: false, message: "Error joining club" });
  }
};

exports.leaveClub = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);

    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }

    club.members = club.members.filter(
      (member) => member.user.toString() !== req.user._id.toString()
    );
    await club.save();

    req.io?.emit("club:updated", {
      clubId: club._id,
      memberCount: club.members.length,
    });

    res.status(200).json({ success: true, message: "Left club", club });
  } catch (error) {
    console.error("Leave club error:", error);
    res.status(500).json({ success: false, message: "Error leaving club" });
  }
};

exports.deleteClub = async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);

    if (!club) {
      return res.status(404).json({ success: false, message: "Club not found" });
    }

    if (!canModerate(req.user) && club.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    await club.deleteOne();
    res.status(200).json({ success: true, message: "Club deleted" });
  } catch (error) {
    console.error("Delete club error:", error);
    res.status(500).json({ success: false, message: "Error deleting club" });
  }
};
