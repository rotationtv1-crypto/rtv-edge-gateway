// Ported from supabase/functions/ai-content-processor/index.ts (Deno) → Cloudflare Workers.
// Runtime env vars arrive via the per-request `env` binding; module-level holders
// are initialised by initEnv(env) at the start of every invocation.
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EdgeFunctionsEnv } from './shared';

// ============================================================
// supabase/functions/ai-content-processor/index.ts
// RotationTV Network — AI Content Pipeline Worker
// Processes ai_content_queue jobs via Venice.ai API
// Models: GLM-5-2 (chat), z-image-turbo (images), 
//         tts-elevenlabs-turbo-v2-5 (speech)
// ============================================================


let VENICE_API_KEY: string;
const VENICE_BASE = 'https://api.venice.ai/api/v1';
let SUPABASE_URL: string;
let SUPABASE_SERVICE_KEY: string;

let supabase: SupabaseClient;

// ── Venice API Clients ──

async function veniceChat(systemPrompt: string, userPrompt: string, maxTokens = 2000) {
  const res = await fetch(`${VENICE_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'zai-org-glm-5-2',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Venice chat error ${res.status}: ${err}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

async function veniceImage(prompt: string, size = '1024x1024') {
  const res = await fetch(`${VENICE_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'z-image-turbo',
      prompt,
      size,
      response_format: 'b64_json',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Venice image error ${res.status}: ${err}`);
  }

  const data = await res.json() as any;
  return data.data?.[0]?.b64_json || null;
}

async function veniceTTS(text: string, voice = 'Alice', speed = 1.0) {
  const res = await fetch(`${VENICE_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-elevenlabs-turbo-v2-5',
      input: text,
      voice,
      response_format: 'mp3',
      speed,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Venice TTS error ${res.status}: ${err}`);
  }

  return await res.arrayBuffer();
}

// ── Job Processors ──

async function processSummarize(job: any) {
  const { data: vod } = await supabase
    .from('VodLibrary')
    .select('title, description, ai_transcript, category, tags')
    .eq('id', job.source_vod_id)
    .single();

  if (!vod) throw new Error('VOD not found');

  const transcript = vod.ai_transcript || vod.description || vod.title;

  const summary = await veniceChat(
    'You are a content summarizer for a streaming platform. Write engaging, concise summaries that make viewers want to watch. Use emojis sparingly.',
    `Summarize this video in 2-3 sentences:\n\nTitle: ${vod.title}\nCategory: ${vod.category}\nContent: ${transcript?.slice(0, 4000) || 'No transcript available'}`,
    500
  );

  // Detect mood
  const mood = await veniceChat(
    'Classify the mood of this content. Respond with exactly ONE word from: energetic, chill, funny, educational, dramatic, romantic, hype',
    `Title: ${vod.title}\nCategory: ${vod.category}\nSummary: ${summary}`,
    10
  );

  const cleanMood = mood.toLowerCase().trim().replace(/[^a-z]/g, '');
  const validMoods = ['energetic', 'chill', 'funny', 'educational', 'dramatic', 'romantic', 'hype'];

  await supabase
    .from('VodLibrary')
    .update({
      ai_summary: summary,
      ai_mood: validMoods.includes(cleanMood) ? cleanMood : 'energetic',
      status: 'ready',
    })
    .eq('id', job.source_vod_id);

  return { summary, mood: cleanMood };
}

async function processTranscribe(job: any) {
  // For now, use Venice chat to generate a placeholder transcript
  // In production, this would use Whisper or Venice's audio endpoint
  const { data: vod } = await supabase
    .from('VodLibrary')
    .select('title, description, category')
    .eq('id', job.source_vod_id)
    .single();

  if (!vod) throw new Error('VOD not found');

  // If we have a Cloudflare recording URL, we'd fetch and transcribe
  // For now, mark as needing manual transcript
  await supabase
    .from('VodLibrary')
    .update({ ai_transcript: `[Transcript pending for: ${vod.title}]` })
    .eq('id', job.source_vod_id);

  return { status: 'pending_audio_source' };
}

async function processChapters(job: any) {
  const { data: vod } = await supabase
    .from('VodLibrary')
    .select('title, ai_transcript, duration_sec, category')
    .eq('id', job.source_vod_id)
    .single();

  if (!vod) throw new Error('VOD not found');

  const chapters = await veniceChat(
    'You generate video chapter timestamps. Output ONLY a JSON array of objects with start_sec (integer) and title (string). No other text.',
    `Generate 5-8 chapters for this ${vod.duration_sec}s video:\nTitle: ${vod.title}\nCategory: ${vod.category}\nTranscript: ${(vod.ai_transcript || '').slice(0, 3000)}`,
    1000
  );

  let parsed;
  try {
    const jsonMatch = chapters.match(/\[.*\]/s);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    parsed = [];
  }

  await supabase
    .from('VodLibrary')
    .update({ ai_chapters: parsed })
    .eq('id', job.source_vod_id);

  return { chapters: parsed };
}

async function processThumbnail(job: any) {
  const { data: vod } = await supabase
    .from('VodLibrary')
    .select('title, category, ai_summary, ai_mood')
    .eq('id', job.source_vod_id)
    .single();

  if (!vod) throw new Error('VOD not found');

  const prompt = await veniceChat(
    'You write image generation prompts for video thumbnails. Output ONLY the prompt, nothing else.',
    `Create a thumbnail prompt for a ${vod.category} stream titled "${vod.title}". Mood: ${vod.ai_mood || 'energetic'}. Style: vibrant, eye-catching, suitable for a streaming platform thumbnail.`,
    200
  );

  const imageB64 = await veniceImage(prompt.trim());

  if (imageB64) {
    // Upload to Supabase Storage
    const binary = Uint8Array.from(atob(imageB64), c => c.charCodeAt(0));
    const path = `thumbnails/${job.source_vod_id}.png`;

    const { error: uploadErr } = await supabase.storage
      .from('vod-assets')
      .upload(path, binary, { contentType: 'image/png', upsert: true });

    if (uploadErr) throw uploadErr;

    const { data: urlData } = supabase.storage
      .from('vod-assets')
      .getPublicUrl(path);

    await supabase
      .from('VodLibrary')
      .update({ thumbnail_url: urlData.publicUrl })
      .eq('id', job.source_vod_id);

    return { thumbnail_url: urlData.publicUrl };
  }

  return { status: 'no_image_generated' };
}

async function processModerate(job: any) {
  const { data: vod } = await supabase
    .from('VodLibrary')
    .select('title, description, ai_transcript, ai_summary')
    .eq('id', job.source_vod_id)
    .single();

  if (!vod) throw new Error('VOD not found');

  const moderation = await veniceChat(
    'You are a content moderator. Analyze the content and respond with a JSON object: {"safe": true/false, "flags": ["flag1", ...], "severity": "none/low/medium/high"}. Valid flags: violence, sexual, hate, harassment, spam, misinformation, drugs, none.',
    `Moderate this content:\nTitle: ${vod.title}\nDescription: ${vod.description || 'N/A'}\nSummary: ${vod.ai_summary || 'N/A'}`,
    200
  );

  let result;
  try {
    const jsonMatch = moderation.match(/\{.*\}/s);
    result = jsonMatch ? JSON.parse(jsonMatch[0]) : { safe: true, flags: [], severity: 'none' };
  } catch {
    result = { safe: true, flags: [], severity: 'none' };
  }

  const updateData: any = { ai_content_flags: result.flags };
  if (!result.safe && result.severity === 'high') {
    updateData.status = 'flagged';
  }

  await supabase
    .from('VodLibrary')
    .update(updateData)
    .eq('id', job.source_vod_id);

  return result;
}

async function processShortForm(job: any) {
  const { data: vod } = await supabase
    .from('VodLibrary')
    .select('title, ai_transcript, ai_summary, ai_chapters, category')
    .eq('id', job.source_vod_id)
    .single();

  if (!vod) throw new Error('VOD not found');

  // Generate a short-form script from the VOD
  const script = await veniceChat(
    'You create short-form video scripts (15-60 seconds) for social media from longer content. Write an engaging hook, key points, and a call-to-action ending.',
    `Create a 30-second short-form script from this video:\nTitle: ${vod.title}\nCategory: ${vod.category}\nSummary: ${vod.ai_summary || 'N/A'}`,
    500
  );

  // Generate TTS narration
  const audioBuffer = await veniceTTS(script, 'Alice', 1.0);

  // Upload audio to storage
  const audioPath = `shorts/${job.source_vod_id}_narration.mp3`;
  const { error: audioErr } = await supabase.storage
    .from('vod-assets')
    .upload(audioPath, audioBuffer, { contentType: 'audio/mpeg', upsert: true });

  if (audioErr) throw audioErr;

  const { data: audioUrl } = supabase.storage
    .from('vod-assets')
    .getPublicUrl(audioPath);

  // Generate thumbnail for the short
  const thumbPrompt = await veniceChat(
    'Write a short image prompt for a vertical short-form video thumbnail. Output ONLY the prompt.',
    `Short-form video about: ${vod.title}. Category: ${vod.category}. Style: bold, vertical, eye-catching.`,
    100
  );

  const thumbB64 = await veniceImage(thumbPrompt.trim(), '1024x1024');

  let thumbnailUrl = null;
  if (thumbB64) {
    const binary = Uint8Array.from(atob(thumbB64), c => c.charCodeAt(0));
    const thumbPath = `shorts/${job.source_vod_id}_thumb.png`;
    await supabase.storage.from('vod-assets').upload(thumbPath, binary, { contentType: 'image/png', upsert: true });
    const { data: thumbUrlData } = supabase.storage.from('vod-assets').getPublicUrl(thumbPath);
    thumbnailUrl = thumbUrlData.publicUrl;
  }

  // Create the short-form VOD entry
  const { data: shortVod } = await supabase
    .from('VodLibrary')
    .insert({
      creator_id: job.creator_id,
      title: `Short: ${vod.title}`,
      description: script.slice(0, 200),
      category: vod.category,
      source_type: 'short',
      source_vod_id: job.source_vod_id,
      thumbnail_url: thumbnailUrl,
      status: 'ready',
      published_at: new Date().toISOString(),
    })
    .select()
    .single();

  return { short_id: shortVod?.id, narration_url: audioUrl?.publicUrl, script };
}

// ── Job Router ──

const PROCESSORS: Record<string, (job: any) => Promise<any>> = {
  summarize: processSummarize,
  transcribe: processTranscribe,
  chapters: processChapters,
  thumbnail_generate: processThumbnail,
  mood_detect: processSummarize, // Combined with summarize
  moderate: processModerate,
  short_form: processShortForm,
  highlight_reel: processSummarize, // Uses chat to identify highlights
  clip_extract: processSummarize, // Uses chat to identify clip points
};

// ── Main Handler ──

let CRON_SECRET: string | undefined;

function initEnv(env: EdgeFunctionsEnv) {
  VENICE_API_KEY = env.VENICE_API_KEY || '';
  SUPABASE_URL = env.SUPABASE_URL || '';
  SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
  CRON_SECRET = env.CRON_SECRET;
  // Degrade gracefully when bindings are absent: auth (CRON_SECRET) still runs
  // first and returns 401; any DB use without bindings fails loudly downstream.
  supabase = SUPABASE_URL
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : (null as unknown as SupabaseClient);
}

export async function handleAiContentProcessor(req: Request, env: EdgeFunctionsEnv): Promise<Response> {
  initEnv(env);
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization');
  const expectedAuth = `Bearer ${CRON_SECRET || 'rtv-ai-processor'}`;
  if (authHeader !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch next queued job (priority order)
    const { data: jobs, error: fetchErr } = await supabase
      .from('AiContentQueue')
      .select('*')
      .eq('status', 'queued')
      .lt('attempts', 3)
      .order('priority', { ascending: true })
      .order('queued_at', { ascending: true })
      .limit(1);

    if (fetchErr) throw fetchErr;
    if (!jobs?.length) {
      return new Response(JSON.stringify({ status: 'no_jobs' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const job = jobs[0];

    // Mark as processing
    await supabase
      .from('AiContentQueue')
      .update({
        status: 'processing',
        started_at: new Date().toISOString(),
        attempts: job.attempts + 1,
      })
      .eq('id', job.id);

    // Process
    const processor = PROCESSORS[job.job_type];
    if (!processor) {
      throw new Error(`Unknown job type: ${job.job_type}`);
    }

    const result = await processor(job);

    // Mark as completed
    await supabase
      .from('AiContentQueue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result,
      })
      .eq('id', job.id);

    return new Response(JSON.stringify({ status: 'completed', job_id: job.id, result }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    // Mark job as failed
    const { data: failedJob } = await supabase
      .from('AiContentQueue')
      .select('id')
      .eq('status', 'processing')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    if (failedJob) {
      await supabase
        .from('AiContentQueue')
        .update({
          status: 'failed',
          error_message: err.message,
        })
        .eq('id', failedJob.id);
    }

    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
