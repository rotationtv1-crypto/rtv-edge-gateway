// Ported from supabase/functions/film-generator/index.ts (Deno) → Cloudflare Workers.
// Runtime env vars arrive via the per-request `env` binding; module-level holders
// are initialised by initEnv(env) at the start of every invocation.
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EdgeFunctionsEnv } from './shared';

// ============================================================
// supabase/functions/film-generator/index.ts
// RotationTV Network — AI Cinematic Film Generator
// Generates full films: script → storyboard → scenes → voice → composite
// Uses Venice.ai: GLM-5-2 (script/dialogue), z-image-turbo (scenes),
//                  tts-elevenlabs-turbo-v2-5 (voice acting)
// ============================================================


let VENICE_API_KEY: string;
const VENICE_BASE = 'https://api.venice.ai/api/v1';
let SUPABASE_URL: string;
let SUPABASE_SERVICE_KEY: string;
let supabase: SupabaseClient;

// ── Venice API ──

async function veniceChat(systemPrompt: string, userPrompt: string, maxTokens = 4000, temp = 0.8) {
  const res = await fetch(`${VENICE_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'zai-org-glm-5-2',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: temp,
    }),
  });
  if (!res.ok) throw new Error(`Venice chat ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

async function veniceImage(prompt: string) {
  const res = await fetch(`${VENICE_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'z-image-turbo',
      prompt,
      size: '1024x1024',
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) throw new Error(`Venice image ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return data.data?.[0]?.b64_json || null;
}

async function veniceTTS(text: string, voice = 'Alice') {
  const res = await fetch(`${VENICE_BASE}/audio/speech`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VENICE_API_KEY}`, 'Content-Type': 'application/json' },
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

async function uploadAsset(path: string, data: Uint8Array | ArrayBuffer, contentType: string) {
  const { error } = await supabase.storage.from('film-assets').upload(path, data, { contentType, upsert: true });
  if (error) throw error;
  const { data: urlData } = supabase.storage.from('film-assets').getPublicUrl(path);
  return urlData.publicUrl;
}

// ── Step 1: Generate Script ──

async function generateScript(film: any) {
  const charactersDesc = (film.characters || []).map((c: any) =>
    `${c.name} (${c.age}, ${c.gender}): ${c.personality}. Background: ${c.background}`
  ).join('\n');

  const script = await veniceChat(
    `You are a professional screenwriter for RotationTV Network. Write a ${film.runtime_target_minutes}-minute ${film.genre} screenplay. Rating: ${film.rating}. Tone: ${film.tone}. Setting: ${film.setting || 'contemporary'}.

Format each scene as:
SCENE [number] - [LOCATION] - [TIME OF DAY]
[Stage directions in brackets]
CHARACTER NAME: Dialogue

Include:
- Opening hook (first 30 seconds must grab attention)
- Rising action with conflict
- Climax
- Resolution with moral/theme
- End card suggestion for next episode

Make it cinematic, engaging, and suitable for cable-grade streaming.`,
    `Write the screenplay for: "${film.title}"

Synopsis: ${film.synopsis || 'Create an original story'}

Characters:
${charactersDesc}

Genre: ${film.genre}
Subgenre: ${(film.subgenre || []).join(', ')}
Tone: ${film.tone}
Setting: ${film.setting || 'Contemporary'}
Runtime target: ${film.runtime_target_minutes} minutes`,
    8000,
    0.85
  );

  await supabase.from('FilmGeneration').update({
    script,
    status: 'storyboarding',
    current_step: 'script_complete',
    progress_pct: 25,
  }).eq('id', film.id);

  return script;
}

// ── Step 2: Generate Storyboard ──

async function generateStoryboard(film: any) {
  const storyboard = await veniceChat(
    'You are a film storyboard artist. Break the screenplay into visual scenes. Output ONLY a JSON array of objects.',
    `Break this screenplay into 8-15 visual scenes for a ${film.runtime_target_minutes}-minute film.

For each scene, provide:
{
  "scene_num": number,
  "title": "short scene title",
  "description": "what happens (2-3 sentences)",
  "image_prompt": "detailed visual description for AI image generation, cinematic lighting, film grain, ${film.genre} aesthetic",
  "narration": "voiceover text for this scene (if any)",
  "dialogue": "key dialogue lines for this scene",
  "duration_sec": estimated_seconds,
  "transition": "cut|fade|dissolve|wipe"
}

Screenplay:
${(film.script || '').slice(0, 6000)}`,
    6000,
    0.7
  );

  let parsed;
  try {
    const jsonMatch = storyboard.match(/\[.*\]/s);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    parsed = [];
  }

  await supabase.from('FilmGeneration').update({
    storyboard: parsed,
    status: 'rendering',
    current_step: 'storyboard_complete',
    progress_pct: 40,
  }).eq('id', film.id);

  return parsed;
}

// ── Step 3: Render Scene Images ──

async function renderScenes(film: any) {
  const storyboard = film.storyboard || [];
  const scenes = [];

  for (let i = 0; i < storyboard.length; i++) {
    const scene = storyboard[i];
    const prompt = scene.image_prompt || `Cinematic ${film.genre} scene: ${scene.description}. Film grain, dramatic lighting, 4K quality.`;

    const imageB64 = await veniceImage(prompt);

    let imageUrl = null;
    if (imageB64) {
      const binary = Uint8Array.from(atob(imageB64), c => c.charCodeAt(0));
      const path = `films/${film.id}/scene_${i + 1}.png`;
      imageUrl = await uploadAsset(path, binary, 'image/png');
    }

    scenes.push({
      ...scene,
      image_url: imageUrl,
      scene_num: i + 1,
    });

    // Update progress
    const pct = 40 + Math.round(((i + 1) / storyboard.length) * 30);
    await supabase.from('FilmGeneration').update({
      current_step: `rendering_scene_${i + 1}_of_${storyboard.length}`,
      progress_pct: pct,
    }).eq('id', film.id);
  }

  await supabase.from('FilmGeneration').update({
    scenes,
    status: 'voicing',
    current_step: 'rendering_complete',
    progress_pct: 70,
    images_generated: scenes.filter(s => s.image_url).length,
  }).eq('id', film.id);

  return scenes;
}

// ── Step 4: Generate Voice Tracks ──

async function generateVoices(film: any) {
  const scenes = film.scenes || [];
  const voiceCast = film.voice_cast || {};
  const voiceTracks: Record<string, string> = {};

  // Generate narration track
  const narrationText = scenes
    .filter((s: any) => s.narration)
    .map((s: any) => s.narration)
    .join(' ... ');

  if (narrationText) {
    const narratorVoice = voiceCast['narrator'] || 'Alice';
    const audioBuffer = await veniceTTS(narrationText, narratorVoice);
    const path = `films/${film.id}/narration.mp3`;
    const url = await uploadAsset(path, audioBuffer, 'audio/mpeg');
    voiceTracks['narrator'] = url;
  }

  // Generate dialogue tracks per character
  const characterDialogues: Record<string, string[]> = {};
  for (const scene of scenes) {
    if (!scene.dialogue) continue;
    // Parse "CHARACTER: text" patterns
    const lines = scene.dialogue.split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z\s]+):\s*(.+)/);
      if (match) {
        const charName = match[1].trim();
        const dialogue = match[2].trim();
        if (!characterDialogues[charName]) characterDialogues[charName] = [];
        characterDialogues[charName].push(dialogue);
      }
    }
  }

  for (const [charName, lines] of Object.entries(characterDialogues)) {
    const voice = voiceCast[charName] || 'Alice';
    const fullDialogue = lines.join(' ... ');
    const audioBuffer = await veniceTTS(fullDialogue, voice);
    const path = `films/${film.id}/voice_${charName.toLowerCase().replace(/\s+/g, '_')}.mp3`;
    const url = await uploadAsset(path, audioBuffer, 'audio/mpeg');
    voiceTracks[charName] = url;
  }

  const totalTtsSec = scenes.reduce((acc: number, s: any) => acc + (s.duration_sec || 0), 0);

  await supabase.from('FilmGeneration').update({
    voice_tracks: voiceTracks,
    status: 'compositing',
    current_step: 'voicing_complete',
    progress_pct: 85,
    tts_seconds: totalTtsSec,
  }).eq('id', film.id);

  return voiceTracks;
}

// ── Step 5: Create Catalog Entry ──

async function createCatalogEntry(film: any) {
  const scenes = film.scenes || [];
  const posterScene = scenes.find((s: any) => s.image_url) || scenes[0];

  const { data: catalogVod } = await supabase.from('CatalogVod').insert({
    creator_id: film.creator_id,
    title: film.title,
    description: film.synopsis || film.script?.slice(0, 500),
    synopsis: film.script?.slice(0, 2000),
    genre: [film.genre, ...(film.subgenre || [])],
    rating: film.rating,
    runtime_minutes: film.runtime_target_minutes,
    source_type: 'film',
    poster_url: posterScene?.image_url,
    backdrop_url: scenes[1]?.image_url || posterScene?.image_url,
    thumbnail_url: posterScene?.image_url,
    ai_summary: `AI-generated ${film.genre} film: ${film.title}`,
    ai_script: film.script,
    ai_storyboard: film.storyboard,
    ai_mood: film.tone,
    access_tier: 'premium',
    tribute_enabled: true,
    status: 'ready',
    published_at: new Date().toISOString(),
  }).select().single();

  if (catalogVod) {
    await supabase.from('FilmGeneration').update({
      catalog_vod_id: catalogVod.id,
      status: 'ready',
      current_step: 'complete',
      progress_pct: 100,
      final_duration_sec: film.runtime_target_minutes * 60,
    }).eq('id', film.id);
  }

  return catalogVod;
}

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

export async function handleFilmGenerator(req: Request, env: EdgeFunctionsEnv): Promise<Response> {
  initEnv(env);
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization');
  const expectedAuth = `Bearer ${CRON_SECRET || 'rtv-film-gen'}`;
  if (authHeader !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const body = await req.json() as any;
    const filmId = body.film_id;

    if (!filmId) {
      // Pick next film in drafting state
      const { data: films } = await supabase
        .from('FilmGeneration')
        .select('*')
        .in('status', ['drafting', 'scripting', 'storyboarding', 'rendering', 'voicing', 'compositing'])
        .order('created_at', { ascending: true })
        .limit(1);

      if (!films?.length) {
        return new Response(JSON.stringify({ status: 'no_films' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const film = films[0];

      switch (film.status) {
        case 'drafting':
        case 'scripting':
          await generateScript(film);
          break;
        case 'storyboarding':
          await generateStoryboard(film);
          break;
        case 'rendering':
          await renderScenes(film);
          break;
        case 'voicing':
          await generateVoices(film);
          break;
        case 'compositing':
          await createCatalogEntry(film);
          break;
      }

      return new Response(JSON.stringify({
        status: 'processing',
        film_id: film.id,
        current_step: film.status,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Process specific film
    const { data: film } = await supabase
      .from('FilmGeneration')
      .select('*')
      .eq('id', filmId)
      .single();

    if (!film) throw new Error('Film not found');

    // Run full pipeline
    await generateScript(film);
    const { data: updatedFilm } = await supabase.from('FilmGeneration').select('*').eq('id', filmId).single();
    if (updatedFilm) await generateStoryboard(updatedFilm);
    const { data: updatedFilm2 } = await supabase.from('FilmGeneration').select('*').eq('id', filmId).single();
    if (updatedFilm2) await renderScenes(updatedFilm2);
    const { data: updatedFilm3 } = await supabase.from('FilmGeneration').select('*').eq('id', filmId).single();
    if (updatedFilm3) await generateVoices(updatedFilm3);
    const { data: updatedFilm4 } = await supabase.from('FilmGeneration').select('*').eq('id', filmId).single();
    if (updatedFilm4) await createCatalogEntry(updatedFilm4);

    return new Response(JSON.stringify({
      status: 'completed',
      film_id: filmId,
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('Film generation error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
