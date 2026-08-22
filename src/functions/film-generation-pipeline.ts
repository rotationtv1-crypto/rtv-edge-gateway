// Ported from supabase/functions/film-generation-pipeline/index.ts (Deno) → Cloudflare Workers.
// Runtime env vars arrive via the per-request `env` binding; module-level holders
// are initialised by initEnv(env) at the start of every invocation.
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EdgeFunctionsEnv } from './shared';

// ============================================================
// supabase/functions/film-generation-pipeline/index.ts
// RotationTV Network — Enterprise Film Generation Pipeline
// Stages: Script → Storyboard → Render → Voice → Composite → QC
// Uses Venice AI (GLM-5.2 + z-image-turbo + TTS)
// Date: 2026-07-04
// ============================================================


let VENICE_API_KEY: string;
const VENICE_BASE = 'https://api.venice.ai/api/v1';
let SUPABASE_URL: string;
let SUPABASE_SERVICE_KEY: string;
let CF_STREAM_TOKEN: string;

let supabase: SupabaseClient;

// ── Venice API ──

async function veniceChat(systemPrompt: string, userPrompt: string, maxTokens = 4000) {
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
      temperature: 0.8,
    }),
  });
  if (!res.ok) throw new Error(`Venice chat ${res.status}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Venice image ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return data.data?.[0]?.b64_json;
}

async function veniceTTS(text: string, voice = 'Alice') {
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
      speed: 1.0,
    }),
  });
  if (!res.ok) throw new Error(`Venice TTS ${res.status}: ${await res.text()}`);
  return await res.arrayBuffer();
}

// ── Upload to Supabase Storage ──

async function uploadToStorage(bucket: string, path: string, data: Uint8Array | ArrayBuffer, contentType: string) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, data, { contentType, upsert: true });
  if (error) throw error;
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
  return urlData.publicUrl;
}

// ── Stage 1: Script Generation ──

async function generateScript(job: any) {
  const config = job.config || {};

  const script = await veniceChat(
    `You are a professional screenwriter for RotationTV Network. Write ${config.format || 'a short film'} screenplays.
Format: Standard screenplay format with scene headings, action lines, character names, and dialogue.
Genre: ${config.genre || 'drama'}
Rating: ${config.rating || 'TV-MA'}
Runtime target: ${config.runtime_min || 15} minutes
Tone: ${config.tone || 'suspenseful'}
Include: Scene numbers, estimated duration per scene, camera directions.`,
    `Write a complete screenplay for: "${config.title || 'Untitled'}"
${config.synopsis ? 'Synopsis: ' + config.synopsis : ''}
${config.characters ? 'Characters: ' + JSON.stringify(config.characters) : ''}
${config.setting ? 'Setting: ' + config.setting : ''}`,
    6000
  );

  // Update film with script
  await supabase.from('FilmCatalog').update({
    ai_script: script,
    generation_status: 'storyboarding',
  }).eq('id', job.film_id);

  // Update job
  await supabase.from('FilmGenerationJob').update({
    stage: 'storyboarding',
    stage_progress: 0.2,
    output_artifacts: { script },
    venice_tokens: (venice_tokens: number) => venice_tokens + 1,
  }).eq('id', job.id);

  return { script_length: script.length };
}

// ── Stage 2: Storyboard Generation ──

async function generateStoryboard(job: any) {
  const { data: film } = await supabase
    .from('FilmCatalog')
    .select('ai_script, title, genre')
    .eq('id', job.film_id)
    .single();

  if (!film?.ai_script) throw new Error('No script found for storyboarding');

  // Generate scene breakdown
  const storyboardJSON = await veniceChat(
    'You generate film storyboards. Output ONLY a JSON array of scene objects. Each scene: {scene_num, heading, description, duration_sec, camera_angle, dialogue_preview, visual_prompt}. The visual_prompt should be a detailed image generation prompt for that scene.',
    `Break this screenplay into a storyboard with 8-15 scenes:\n\n${film.ai_script.slice(0, 8000)}`,
    4000
  );

  let storyboard;
  try {
    const match = storyboardJSON.match(/\[.*\]/s);
    storyboard = match ? JSON.parse(match[0]) : [];
  } catch {
    storyboard = [];
  }

  // Generate key frame images for each scene
  const sceneImages = [];
  for (const scene of storyboard.slice(0, 12)) {
    const prompt = scene.visual_prompt || `Cinematic scene: ${scene.description}. Genre: ${film.genre}. Style: professional film, dramatic lighting, 16:9 aspect ratio.`;
    const b64 = await veniceImage(prompt, '1024x1024');

    if (b64) {
      const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const url = await uploadToStorage(
        'film-assets',
        `storyboards/${job.film_id}/scene_${scene.scene_num}.png`,
        binary,
        'image/png'
      );
      sceneImages.push({ ...scene, image_url: url });
    } else {
      sceneImages.push(scene);
    }
  }

  await supabase.from('FilmCatalog').update({
    ai_storyboard: sceneImages,
    generation_status: 'rendering',
  }).eq('id', job.film_id);

  await supabase.from('FilmGenerationJob').update({
    stage: 'rendering',
    stage_progress: 0.4,
    output_artifacts: { storyboard: sceneImages },
  }).eq('id', job.id);

  return { scenes: sceneImages.length };
}

// ── Stage 3: Voice-Over / Narration ──

async function generateVoiceOver(job: any) {
  const { data: film } = await supabase
    .from('FilmCatalog')
    .select('ai_script, ai_storyboard, title')
    .eq('id', job.film_id)
    .single();

  if (!film?.ai_script) throw new Error('No script for voice-over');

  // Extract narration/dialogue from script
  const narration = await veniceChat(
    'Extract all narration and dialogue from this screenplay. Format as a single narration script suitable for text-to-speech. Remove scene headings and camera directions. Keep only spoken words.',
    film.ai_script.slice(0, 6000),
    3000
  );

  // Generate TTS
  const voice = job.config?.voice || 'Alice';
  const audioBuffer = await veniceTTS(narration, voice);

  const audioUrl = await uploadToStorage(
    'film-assets',
    `audio/${job.film_id}/narration.mp3`,
    audioBuffer,
    'audio/mpeg'
  );

  await supabase.from('FilmCatalog').update({
    ai_narration_url: audioUrl,
    generation_status: 'compositing',
  }).eq('id', job.film_id);

  await supabase.from('FilmGenerationJob').update({
    stage: 'compositing',
    stage_progress: 0.7,
    output_artifacts: { narration_url: audioUrl },
  }).eq('id', job.id);

  return { narration_url: audioUrl };
}

// ── Stage 4: Thumbnail + Poster ──

async function generatePosterAndThumbnail(job: any) {
  const { data: film } = await supabase
    .from('FilmCatalog')
    .select('title, genre, ai_storyboard, ai_script')
    .eq('id', job.film_id)
    .single();

  if (!film) throw new Error('Film not found');

  // Generate poster prompt
  const posterPrompt = await veniceChat(
    'Write a cinematic poster image prompt. Output ONLY the prompt. Style: professional movie poster, dramatic, eye-catching.',
    `Movie: "${film.title}". Genre: ${film.genre}. Create a poster that captures the essence of this film.`,
    200
  );

  // Generate poster (portrait)
  const posterB64 = await veniceImage(posterPrompt.trim(), '1024x1024');
  let posterUrl = null;
  if (posterB64) {
    const binary = Uint8Array.from(atob(posterB64), c => c.charCodeAt(0));
    posterUrl = await uploadToStorage('film-assets', `posters/${job.film_id}.png`, binary, 'image/png');
  }

  // Generate thumbnail (landscape)
  const thumbPrompt = await veniceChat(
    'Write a cinematic thumbnail prompt. Output ONLY the prompt. Style: 16:9 landscape, bold, streaming platform thumbnail.',
    `Movie: "${film.title}". Genre: ${film.genre}. Create a thumbnail.`,
    200
  );

  const thumbB64 = await veniceImage(thumbPrompt.trim(), '1024x1024');
  let thumbUrl = null;
  if (thumbB64) {
    const binary = Uint8Array.from(atob(thumbB64), c => c.charCodeAt(0));
    thumbUrl = await uploadToStorage('film-assets', `thumbnails/${job.film_id}.png`, binary, 'image/png');
  }

  await supabase.from('FilmCatalog').update({
    poster_url: posterUrl,
    thumbnail_url: thumbUrl,
    generation_status: 'qc',
  }).eq('id', job.film_id);

  await supabase.from('FilmGenerationJob').update({
    stage: 'qc',
    stage_progress: 0.9,
    output_artifacts: { poster_url: posterUrl, thumbnail_url: thumbUrl },
  }).eq('id', job.id);

  return { poster_url: posterUrl, thumbnail_url: thumbUrl };
}

// ── Stage 5: QC + Publish ──

async function qualityCheckAndPublish(job: any) {
  const { data: film } = await supabase
    .from('FilmCatalog')
    .select('ai_script, ai_storyboard, ai_narration_url, poster_url, thumbnail_url, title')
    .eq('id', job.film_id)
    .single();

  if (!film) throw new Error('Film not found');

  // Verify all assets exist
  const checks = {
    has_script: !!film.ai_script,
    has_storyboard: !!(film.ai_storyboard && film.ai_storyboard.length > 0),
    has_narration: !!film.ai_narration_url,
    has_poster: !!film.poster_url,
    has_thumbnail: !!film.thumbnail_url,
  };

  const allPassed = Object.values(checks).every(v => v);

  if (allPassed) {
    // Calculate runtime from storyboard
    const totalSec = (film.ai_storyboard || []).reduce((sum: number, s: any) => sum + (s.duration_sec || 120), 0);

    await supabase.from('FilmCatalog').update({
      generation_status: 'ready',
      status: 'published',
      published_at: new Date().toISOString(),
      runtime_min: Math.round(totalSec / 60),
    }).eq('id', job.film_id);

    await supabase.from('FilmGenerationJob').update({
      stage: 'completed',
      stage_progress: 1.0,
      completed_at: new Date().toISOString(),
    }).eq('id', job.id);
  } else {
    await supabase.from('FilmCatalog').update({
      generation_status: 'failed',
    }).eq('id', job.film_id);

    await supabase.from('FilmGenerationJob').update({
      stage: 'failed',
      error_message: `QC failed: ${JSON.stringify(checks)}`,
    }).eq('id', job.id);
  }

  return { qc: checks, passed: allPassed };
}

// ── Full Film Pipeline (orchestrates all stages) ──

async function runFullPipeline(job: any) {
  const stages = [
    { name: 'scripting', fn: generateScript },
    { name: 'storyboarding', fn: generateStoryboard },
    { name: 'voicing', fn: generateVoiceOver },
    { name: 'compositing', fn: generatePosterAndThumbnail },
    { name: 'qc', fn: qualityCheckAndPublish },
  ];

  for (const stage of stages) {
    try {
      await supabase.from('FilmGenerationJob').update({
        stage: stage.name,
        started_at: new Date().toISOString(),
      }).eq('id', job.id);

      const result = await stage.fn(job);
      console.log(`Stage ${stage.name} complete:`, JSON.stringify(result));
    } catch (error: any) {
      console.error(`Stage ${stage.name} failed:`, error);
      await supabase.from('FilmGenerationJob').update({
        stage: 'failed',
        error_message: `${stage.name}: ${error.message}`,
      }).eq('id', job.id);
      throw error;
    }
  }
}

// ── Job Router ──

const JOB_PROCESSORS: Record<string, (job: any) => Promise<any>> = {
  script: generateScript,
  storyboard: generateStoryboard,
  voice_over: generateVoiceOver,
  thumbnail: generatePosterAndThumbnail,
  full_film: runFullPipeline,
  short_form: runFullPipeline,
  clip: generatePosterAndThumbnail,
};

// ── Main Handler ──

let CRON_SECRET: string | undefined;

function initEnv(env: EdgeFunctionsEnv) {
  VENICE_API_KEY = env.VENICE_API_KEY || '';
  SUPABASE_URL = env.SUPABASE_URL || '';
  SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
  CF_STREAM_TOKEN = env.CF_STREAM_TOKEN || '';
  CRON_SECRET = env.CRON_SECRET;
  // Degrade gracefully when bindings are absent: auth (CRON_SECRET) still runs
  // first and returns 401; any DB use without bindings fails loudly downstream.
  supabase = SUPABASE_URL
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : (null as unknown as SupabaseClient);
}

export async function handleFilmGenerationPipeline(req: Request, env: EdgeFunctionsEnv): Promise<Response> {
  initEnv(env);
  if (req.method !== 'POST') {
    return new Response('RotationTV Film Generation Pipeline', { status: 200 });
  }

  const authHeader = req.headers.get('Authorization');
  const expectedAuth = `Bearer ${CRON_SECRET || 'rtv-film-pipeline'}`;
  if (authHeader !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch next job
    const { data: jobs, error: fetchErr } = await supabase
      .from('FilmGenerationJob')
      .select('*')
      .eq('stage', 'queued')
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

    await supabase.from('FilmGenerationJob').update({
      stage: 'scripting',
      started_at: new Date().toISOString(),
      attempts: job.attempts + 1,
    }).eq('id', job.id);

    const processor = JOB_PROCESSORS[job.job_type];
    if (!processor) throw new Error(`Unknown job type: ${job.job_type}`);

    await processor(job);

    return new Response(JSON.stringify({ status: 'completed', job_id: job.id }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
