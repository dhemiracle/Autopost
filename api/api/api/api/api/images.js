// api/images.js — DALL-E image generation for Instagram, X & Facebook
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const IMAGE_SCHEDULE = {
  limited:   ['morning', 'evening'],
  unlimited: ['morning', 'evening'],
  pro:       ['morning', 'afternoon', 'night'],
  agency:    ['morning', 'afternoon', 'night']
};

const IMAGE_LIMITS = {
  limited: 2,
  unlimited: 2,
  pro: 3,
  agency: 3
};

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

  const { niche, timeSlot, platforms } = req.body;
  // timeSlot: 'morning' | 'afternoon' | 'evening' | 'night'
  // platforms: array e.g. ['instagram', 'x', 'facebook']

  const plan = profile.plan;
  const allowedSlots = IMAGE_SCHEDULE[plan] || ['morning', 'evening'];

  if (!allowedSlots.includes(timeSlot)) {
    return res.status(403).json({ error: `${timeSlot} image post not available on ${plan} plan` });
  }

  // Check daily image post count
  const today = new Date().toISOString().split('T')[0];
  const { count } = await supabase
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('source', 'image')
    .gte('created_at', `${today}T00:00:00Z`);

  const dailyLimit = IMAGE_LIMITS[plan] || 2;
  if ((count || 0) >= dailyLimit) {
    return res.status(429).json({ error: `Daily image limit reached (${dailyLimit}/day on ${plan} plan)` });
  }

  // Generate image prompt based on niche and time slot
  const timeContext = {
    morning: 'bright, energetic morning vibes',
    afternoon: 'productive, daytime professional energy',
    evening: 'warm, golden hour evening mood',
    night: 'sleek, nighttime professional atmosphere'
  };

  const prompt = `A stunning, professional social media image for the ${niche} niche with ${timeContext[timeSlot] || 'modern professional'}. 
  High quality, visually striking, suitable for Instagram, Facebook and X. 
  No text overlays. Clean, modern aesthetic. Ultra realistic.`;

  // Call DALL-E 3
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard'
    })
  });

  const data = await response.json();
  if (!response.ok) return res.status(500).json({ error: data.error?.message || 'Image generation failed' });

  const imageUrl = data.data[0].url;

  // Generate caption using Claude
  const captionRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write an engaging ${timeSlot} social media caption for the ${niche} niche. 
        Include relevant hashtags. Max 200 characters for X, 400 for Instagram/Facebook. 
        Return ONLY the caption, nothing else.`
      }]
    })
  });

  const captionData = await captionRes.json();
  const caption = captionData.content?.[0]?.text?.trim() || `Good ${timeSlot}! #${niche.replace(/\s+/g, '')}`;

  // Save to posts table
  const platformStr = (platforms || ['instagram', 'x', 'facebook']).join(',');
  await supabase.from('posts').insert({
    user_id: user.id,
    content: caption,
    platform: platformStr,
    niche,
    source: 'image',
    status: 'posted',
    posted_at: new Date().toISOString()
  });

  return res.status(200).json({
    imageUrl,
    caption,
    timeSlot,
    platforms: platforms || ['instagram', 'x', 'facebook']
  });
  }
