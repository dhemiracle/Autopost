// api/videos.js — Google Veo video generation with smart queue system
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VIDEO_LIMITS_PER_WEEK = {
  limited:   0,
  unlimited: 1,
  pro:       2,
  agency:    2
};

const DAILY_VIDEO_CAP = 40; // Max videos generated per day across all users

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Check trial validity
  if (profile.on_trial && new Date() > new Date(profile.trial_ends)) {
    return res.status(403).json({ error: 'Trial expired. Please subscribe to continue.' });
  }

  // Check plan allows videos
  const weeklyLimit = VIDEO_LIMITS_PER_WEEK[profile.plan] || 0;
  if (weeklyLimit === 0) {
    return res.status(403).json({ error: 'Video posts not available on your plan. Upgrade to Unlimited or higher.' });
  }

  // Check weekly video count for this user
  const weekStart = getWeekStart();
  const { count: weeklyCount } = await supabase
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('source', 'video')
    .gte('created_at', weekStart);

  if ((weeklyCount || 0) >= weeklyLimit) {
    return res.status(429).json({
      error: `Weekly video limit reached (${weeklyLimit}/week on ${profile.plan} plan)`,
      queued: false
    });
  }

  // ── DAILY CAP CHECK — Queue system ──
  const today = new Date().toISOString().split('T')[0];
  const { count: todayVideoCount } = await supabase
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'video')
    .gte('created_at', `${today}T00:00:00Z`);

  if ((todayVideoCount || 0) >= DAILY_VIDEO_CAP) {
    // Queue for tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0); // 9 AM tomorrow

    await supabase.from('posts').insert({
      user_id: user.id,
      content: '',
      platform: 'instagram,x,facebook',
      niche: req.body.niche,
      source: 'video',
      status: 'scheduled',
      scheduled_for: tomorrow.toISOString()
    });

    return res.status(200).json({
      queued: true,
      message: 'Daily video limit reached. Your video has been queued for tomorrow!',
      scheduledFor: tomorrow.toISOString()
    });
  }

  const { niche } = req.body;

  // ── GENERATE VIDEO SCRIPT/PROMPT ──
  const scriptRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write a short video generation prompt for a 6-second social media video about the ${niche} niche.
        Should be visually dynamic, professional and engaging.
        Max 50 words. Return ONLY the prompt, nothing else.`
      }]
    })
  });

  const scriptData = await scriptRes.json();
  const videoPrompt = scriptData.content?.[0]?.text?.trim() ||
    `Professional ${niche} social media video, dynamic visuals, modern aesthetic, 6 seconds`;

  // ── CALL GOOGLE VEO API ──
  const veoRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=${process.env.GOOGLE_VEO_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{
          prompt: videoPrompt
        }],
        parameters: {
          aspectRatio: '9:16',  // Vertical — best for Instagram Reels, TikTok style
          durationSeconds: 6,
          sampleCount: 1
        }
      })
    }
  );

  const veoData = await veoRes.json();

  if (!veoRes.ok) {
    return res.status(500).json({ error: veoData.error?.message || 'Video generation failed' });
  }

  // Veo returns an operation name for async processing
  const operationName = veoData.name;

  // ── GENERATE CAPTION ──
  const captionRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write an engaging video caption for a ${niche} niche social media video post. 
        Include relevant hashtags. Max 300 characters. Return ONLY the caption.`
      }]
    })
  });

  const captionData = await captionRes.json();
  const caption = captionData.content?.[0]?.text?.trim() || `Check this out! #${niche.replace(/\s+/g, '')}`;

  // Save to posts table as pending (video still generating)
  const { data: post } = await supabase.from('posts').insert({
    user_id: user.id,
    content: caption,
    platform: 'instagram,x,facebook',
    niche,
    source: 'video',
    status: 'pending',
    posted_at: null,
    error_message: operationName // temporarily store operation name
  }).select().single();

  return res.status(200).json({
    queued: false,
    postId: post?.id,
    operationName,
    caption,
    message: 'Video is being generated! Check back in 2-3 minutes.'
  });
}

// ── POLL VIDEO STATUS ──
export async function checkVideoStatus(req, res) {
  const { operationName } = req.body;
  if (!operationName) return res.status(400).json({ error: 'Missing operation name' });

  const pollRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${process.env.GOOGLE_VEO_API_KEY}`
  );
  const data = await pollRes.json();

  if (data.done) {
    const videoUri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    return res.status(200).json({ done: true, videoUrl: videoUri });
  }

  return res.status(200).json({ done: false, message: 'Still generating...' });
}

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
      }
