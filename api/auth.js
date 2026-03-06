// api/auth.js — Handles signup and login via Supabase
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, name, email, password, plan } = req.body;

  // ── SIGNUP ──
  if (action === 'signup') {
    if (!name || !email || !password || !plan) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, plan }
    });

    if (error) return res.status(400).json({ error: error.message });

    // Update profile with plan
    await supabase
      .from('profiles')
      .update({ plan, name })
      .eq('id', data.user.id);

    // Sign in to get session token
    const { data: session, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) return res.status(400).json({ error: signInError.message });

    // Get profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    return res.status(200).json({
      user: profile,
      token: session.session.access_token
    });
  }

  // ── LOGIN ──
  if (action === 'login') {
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing email or password' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Invalid email or password' });

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    return res.status(200).json({
      user: profile,
      token: data.session.access_token
    });
  }

  return res.status(400).json({ error: 'Invalid action' });
  }
