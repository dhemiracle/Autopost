// api/scheduler.js — Auto-scheduler for image and video posts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Time slots for image posts (24hr format)
const TIME_SLOTS = {
  morning:   { hour: 8,  label: 'morning' },
  afternoon: { hour: 13, label: 'afternoon' },
  evening:   { hour: 18, label: 'evening' },
  night:     { hour: 21, label: 'night' }
};

const IMAGE_SCHEDULE = {
  limited:   ['morning', 'evening'],
  unlimited: ['morning', 'evening'],
  pro:       ['morning', 'afternoon', 'night'],
  agency:    ['morning', 'afternoon', 'night']
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-cron-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Secure this endpoint — only callable by cron or authorized requests
  const cronSecret = req.headers['x-cron-secret'];
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (cronSecret !== process.env.CRON_SECRET && !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, userId } = req.body;
  const currentHour = new Date().getHours();

  // ── DETERMINE CURRENT TIME SLOT ──
  function getCurrentSlot() {
    if (currentHour >= 6 && currentHour < 11)  return 'morning';
    if (currentHour >= 11 && currentHour < 15) return 'afternoon';
    if (currentHour >= 15 && currentHour < 20) return 'evening';
    if (currentHour >= 20)                     return 'night';
    return null;
  }

  // ── RUN IMAGE SCHEDULER ──
  if (action === 'run_image_schedule') {
    const slot = getCurrentSlot();
    if (!slot) return res.status(200).json({ message: 'No image slot at this hour' });

    // Get all active users whose plan includes this slot
    const { data: users } = await supabase
      .from('profiles')
      .select('*')
      .eq('is_active', true);

    if (!users || users.length === 0) {
      return res.status(200).json({ message: 'No active users' });
    }

    const results = [];
    const today = new Date().toISOString().split('T')[0];

    for (const user of users) {
      const allowedSlots = IMAGE_SCHEDULE[user.plan] || ['morning', 'evening'];
      if (!allowedSlots.includes(slot)) continue;

      // Check if already posted this slot today
      const { count } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('source', 'image')
        .like('error_message', `%${slot}%`)
        .gte('created_at', `${today}T00:00:00Z`);

      if ((count || 0) > 0) continue; // Already posted this slot

      // Check trial
      if (user.on_trial && new Date() > new Date(user.trial_ends)) continue;

      results.push({ userId: user.id, slot, niche: 'Business', plan: user.plan });
    }

    return res.status(200).json({
      slot,
      usersToPost: results.length,
      users: results
    });
  }

  // ── RUN VIDEO SCHEDULER ──
  if (action === 'run_video_schedule') {
    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = new Date().getDay(); // 0=Sun, 1=Mon...

    // Only run video schedule on Monday and Thursday
    if (dayOfWeek !== 1 && dayOfWeek !== 4) {
      return res.status(200).json({ message: 'Not a video posting day' });
    }

    const { data: videoUsers } = await supabase
      .from('profiles')
      .select('*')
      .eq('is_active', true)
      .in('plan', ['unlimited', 'pro', 'agency']);

    if (!videoUsers || videoUsers.length === 0) {
      return res.status(200).json({ message: 'No video users' });
    }

    // Get week start
    const weekStart = getWeekStart();

    // Sort users by last video date (oldest first = fair queue)
    const videoQueue = [];
    for (const user of videoUsers) {
      const { count: weeklyCount } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('source', 'video')
        .gte('created_at', weekStart);

      const weeklyLimit = user.plan === 'unlimited' ? 1 : 2;
      if ((weeklyCount || 0) < weeklyLimit) {
        videoQueue.push({ userId: user.id, plan: user.plan, weeklyCount });
      }
    }

    // Cap at 40 per day
    const todaySlice = videoQueue.slice(0, 40);
    const queuedForTomorrow = videoQueue.slice(40);

    // Queue overflow for tomorrow
    if (queuedForTomorrow.length > 0) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);

      for (const u of queuedForTomorrow) {
        await supabase.from('scheduled_jobs').upsert({
          user_id: u.userId,
          job_type: 'video_post',
          next_run: tomorrow.toISOString(),
          is_running: false
        });
      }
    }

    return res.status(200).json({
      videosToGenerate: todaySlice.length,
      queuedForTomorrow: queuedForTomorrow.length,
      users: todaySlice
    });
  }

  // ── PROCESS SCHEDULED POSTS ──
  if (action === 'process_scheduled') {
    const { data: scheduledPosts } = await supabase
      .from('posts')
      .select('*')
      .eq('status', 'scheduled')
      .lte('scheduled_for', new Date().toISOString())
      .limit(40);

    return res.status(200).json({
      scheduledPosts: scheduledPosts?.length || 0,
      posts: scheduledPosts
    });
  }

  return res.status(400).json({ error: 'Invalid action' });
}

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}
