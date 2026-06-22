// Publishes scheduled announcements. Display-side visibility is already handled
// by the publishAt filter in the controller; this job sends the broadcast
// notification once an announcement's publishAt passes.
//
// Only announcements created with a publishAt field (i.e. since this feature
// shipped) are considered, so legacy rows are never re-notified. The `notified`
// flag guards against double-sends.
const Announcement = require("../models/Announcement");
const { broadcastNotification } = require("./notificationHelper");

const CHECK_INTERVAL_MS = 60 * 1000; // every minute

const runOnce = async (io) => {
  const now = new Date();
  const due = await Announcement.find({
    approved: true,
    notified: { $ne: true },
    publishAt: { $exists: true, $lte: now },
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ],
  }).limit(50);

  for (const a of due) {
    a.notified = true;
    await a.save();

    const audience =
      a.department && a.department !== "All"
        ? { department: a.department }
        : undefined;

    await broadcastNotification(io, {
      excludeUser: a.postedBy,
      audience,
      title: "New announcement",
      message: `${a.title}${
        a.department && a.department !== "All" ? ` (${a.department})` : ""
      }`,
      type: "announcement",
      sender: a.postedBy,
      link: `/announcements?highlight=${a._id}`,
      metadata: { announcementId: a._id },
    });
    io?.emit("announcement:new", a);
  }
};

const startAnnouncementScheduler = (io) => {
  const tick = () =>
    runOnce(io).catch((e) =>
      console.error("Announcement scheduler error:", e.message)
    );
  tick();
  return setInterval(tick, CHECK_INTERVAL_MS);
};

module.exports = { startAnnouncementScheduler };
