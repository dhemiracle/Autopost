// api/generate.js — Secure Claude AI content generation proxy
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify user token
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  // Get user profile & check limits
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Check if trial is still valid
  const trialEnds = new Date(profile.trial_ends);
  if (profile.on_trial && new Date() > trialEnds) {
    return res.status(403).json({ error: 'Trial expired. Please subscribe to continue.' });
  }

  // Check daily post limit
  const planLimits = { limited: 5, unlimited: 20, pro: 20, agency: 20 };
  const limit = planLimits[profile.plan] || 5;
  const today = new Date().toISOString().split('T')[0];
  const postsToday = profile.last_post_date === today ? profile.posts_today : 0;

  if (postsToday >= limit) {
    return res.status(429).json({ error: `Daily limit reached (${limit} posts/day on ${profile.plan} plan)` });
  }

  const { niche, source, keyword, platform, contentType } = req.body;

  // Build prompt based on source
  let prompt;
  if (source === 'scrape') {
    prompt = `You are a social media expert. Generate ONE high-performing ${platform === 'x' ? 'tweet' : 'Facebook post'} about "${keyword}".
    Make it trending, engaging, and use relevant hashtags.
    ${platform === 'x' ? 'Max 280 characters.' : 'Max 500 characters.'}
    Return ONLY the post text, nothing else.`;
  } else if (contentType === 'image_caption') {
    prompt = `You are a social media expert. Generate a compelling image post caption for the ${niche} niche.
    Make it inspirational, engaging and include relevant hashtags.
    ${platform === 'x' ? 'Max 280 characters.' : 'Max 500 characters.'}
    Return ONLY the caption text, nothing else.`;
  } else {
    prompt = `You are a social media expert. Generate ONE viral ${platform === 'x' ? 'tweet' : 'Facebook post'} about trending topics in the ${niche} niche.
    Make it engaging, informative, and include relevant hashtags.
    ${platform === 'x' ? 'Max 280 characters.' : 'Max 500 characters.'}
    Return ONLY the post text, nothing else.`;
  }

  // Call Claude API securely from server
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) return res.status(500).json({ error: 'AI generation failed' });

  const content = data.content[0].text.trim();
  return res.status(200).json({ content });
      }
