// api/posts.js — Save, retrieve and manage posts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getUser(token) {
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  // ── GET POSTS ──
  if (req.method === 'GET') {
    const { data: posts, error } = await supabase
      .from('posts')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ posts });
  }

  // ── SAVE POST ──
  if (req.method === 'POST') {
    const { content, platform, niche, source, status, scheduled_for } = req.body;
    if (!content || !platform) return res.status(400).json({ error: 'Missing content or platform' });

    const { data: post, error } = await supabase
      .from('posts')
      .insert({
        user_id: user.id,
        content,
        platform,
        niche,
        source,
        status: status || 'posted',
        posted_at: status === 'posted' ? new Date().toISOString() : null,
        scheduled_for: scheduled_for || null
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Update daily count
    const today = new Date().toISOString().split('T')[0];
    await supabase.rpc('increment_post_count', { user_id_input: user.id, today_date: today });

    return res.status(200).json({ post });
  }

  return res.status(405).json({ error: 'Method not allowed' });
                            }
