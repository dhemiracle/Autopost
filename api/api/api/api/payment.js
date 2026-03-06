// api/payment.js — Paystack payment initialization and verification
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLAN_AMOUNTS = {
  limited: 300000,   // ₦3,000 in kobo
  unlimited: 500000, // ₦5,000 in kobo
  pro: 1000000,      // ₦10,000 in kobo
  agency: 2500000    // ₦25,000 in kobo
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

  const { action, plan, reference } = req.body;

  // ── INITIALIZE PAYMENT ──
  if (action === 'initialize') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email, name')
      .eq('id', user.id)
      .single();

    const amount = PLAN_AMOUNTS[plan];
    if (!amount) return res.status(400).json({ error: 'Invalid plan' });

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: profile.email,
        amount,
        currency: 'NGN',
        metadata: {
          user_id: user.id,
          plan,
          name: profile.name
        },
        callback_url: `${process.env.APP_URL}/payment-success`
      })
    });

    const data = await response.json();
    if (!data.status) return res.status(400).json({ error: data.message });

    return res.status(200).json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  }

  // ── VERIFY PAYMENT ──
  if (action === 'verify') {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });

    const data = await response.json();
    if (!data.status || data.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    const plan = data.data.metadata.plan;
    const userId = data.data.metadata.user_id;

    // Update user plan
    await supabase
      .from('profiles')
      .update({ plan, on_trial: false })
      .eq('id', userId);

    // Save subscription record
    await supabase.from('subscriptions').insert({
      user_id: userId,
      plan,
      paystack_reference: reference,
      amount: data.data.amount,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });

    return res.status(200).json({ success: true, plan });
  }

  return res.status(400).json({ error: 'Invalid action' });
      }
