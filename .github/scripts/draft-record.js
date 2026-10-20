// Build a draft corpus record from an accepted paper-submission issue.
// Used by .github/workflows/accept-submission.yml; also runnable locally for testing:
//   node .github/scripts/draft-record.js <issue-body-file> [issue-number]
'use strict';
const fs = require('fs');
const path = require('path');

const MODALITY = {
  'Image': 'image',
  'Video & streaming': 'video_streaming',
  'Audio & speech': 'audio_speech',
  'GUI & computer use': 'gui',
  'Embodied & 3D': 'embodied_3d',
};
const LEAF = {
  'Retained perceptual source evidence': 'retained_perceptual_source_evidence',
  'Modality-specific encodings & geometric state': 'modality_specific_encodings_and_geometric_state',
  'Perception-to-text records & summaries': 'perception_to_text_records_and_summaries',
  'Spatial, temporal & cross-modal structured memory': 'spatial_temporal_and_cross_modal_structured_memory',
  'Persistent multimodal latent state': 'persistent_multimodal_latent_state',
  'Experience-conditioned parametric memory': 'experience_conditioned_parametric_memory',
};
const FAMILY_OF = {
  retained_perceptual_source_evidence: 'source_preserving_and_modality_native_memory',
  modality_specific_encodings_and_geometric_state: 'source_preserving_and_modality_native_memory',
  perception_to_text_records_and_summaries: 'cross_represented_explicit_memory',
  spatial_temporal_and_cross_modal_structured_memory: 'cross_represented_explicit_memory',
  persistent_multimodal_latent_state: 'internalized_latent_and_parametric_memory',
  experience_conditioned_parametric_memory: 'internalized_latent_and_parametric_memory',
};
const STORAGE = {
  'Flat sequential records': 'flat_sequential_record_store',
  'Vector-indexed collection': 'vector_indexed_collection',
  'Graph / relational store': 'graph_relational_store',
  'Hierarchical multi-tier store': 'hierarchical_multi_tier_store',
  'Modular adapter bank': 'modular_adapter_store_bank',
};
const RETRIEVAL = {
  'Similarity search': 'similarity_based_retrieval',
  'Metadata / spatiotemporal lookup': 'metadata_spatiotemporal_retrieval',
  'Structure traversal': 'structure_based_traversal',
  'Planner / tool-assisted retrieval': 'planner_tool_assisted_retrieval',
  'Latent / parametric activation': 'latent_parametric_activation',
};
const T3 = {
  'Write policy': 'write_policy_evolution',
  'Maintenance policy': 'maintenance_policy_evolution',
  'Retrieval policy': 'retrieval_policy_evolution',
};

/** Split an issue-form body into { heading: value }. "_No response_" becomes ''. */
function sections(body) {
  const out = {};
  const parts = String(body || '').split(/^###\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const head = (nl < 0 ? p : p.slice(0, nl)).trim();
    const val = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    out[head] = val === '_No response_' ? '' : val;
  }
  return out;
}

/** Read "- Key: a, b" lines from the classification text. */
function classification(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const list = (v, map) =>
  !v || /^(—|not specified)$/i.test(v)
    ? []
    : v.split(',').map((x) => map[x.trim()]).filter(Boolean);

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'submission';

function parseArxiv(xml) {
  const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
  if (!entry) return null;
  const tag = (t) => ((entry.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
  return { title: tag('title'), published: tag('published').slice(0, 10), authors };
}

/** Fetch title/authors/date: Hugging Face papers API first, arXiv API as fallback. Never throws. */
async function fetchMeta(id, timeoutMs = 15000) {
  if (!id) return null;
  const get = async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      return r.ok ? r : null;
    } finally {
      clearTimeout(t);
    }
  };
  try {
    const r = await get(`https://huggingface.co/api/papers/${id}`);
    if (r) {
      const j = await r.json();
      if (j.title) {
        return {
          title: j.title.replace(/\s+/g, ' ').trim(),
          published: String(j.publishedAt || '').slice(0, 10),
          authors: (j.authors || []).map((a) => a.name).filter(Boolean),
        };
      }
    }
  } catch (e) {
    /* fall through to arXiv */
  }
  try {
    const r = await get(`https://export.arxiv.org/api/query?id_list=${id}`);
    if (r) return parseArxiv(await r.text());
  } catch (e) {
    /* give up: the draft is still created from the issue fields */
  }
  return null;
}

/** Pure function: issue fields + arXiv metadata -> { record, relPath }. */
function buildRecord({ body, number, arxiv, today }) {
  const s = sections(body);
  const c = classification(s['Suggested classification']);
  const id = ((s['arXiv link'] || '').match(/(\d{4}\.\d{4,5})/) || [])[1] || null;
  const modality = MODALITY[s['Primary modality']] || null;
  if (!modality) throw new Error(`Unknown or missing primary modality: "${s['Primary modality'] || ''}"`);
  const kind = /benchmark/i.test(s['Record type'] || c['Record type'] || '') ? 'benchmark' : 'architecture';
  const title = s['Paper title'] || (arxiv && arxiv.title) || '';
  const name = s['System or benchmark name'] || title.split(':')[0].trim() || (id ? `arXiv ${id}` : 'Submission');
  const year = ((arxiv && arxiv.published) || today).slice(0, 4);
  const authors = (arxiv && arxiv.authors.length ? arxiv.authors : (c['Authors'] && c['Authors'] !== 'not specified' ? c['Authors'].split(/,\s*/) : []));
  const latest = id
    ? {
        version_label: `latest arXiv version fetched ${today}`,
        published_date: (arxiv && arxiv.published) || '',
        source_url: `https://arxiv.org/abs/${id}`,
        pdf_url: `https://arxiv.org/pdf/${id}`,
        doi: `10.48550/arXiv.${id}`,
      }
    : { version_label: 'as submitted', published_date: '', source_url: s['arXiv link'] || '', pdf_url: '', doi: '' };
  const evidenceNote = s['Evidence in the paper'] || '';
  const evidence = evidenceNote ? [{ section: 'Submitter note', page: '', figure_or_table: '', paraphrase: evidenceNote }] : [];
  const note = `Draft generated from submission issue #${number} on ${today}; classification as submitted, pending maintainer review.`;

  if (kind === 'benchmark') {
    return {
      relPath: path.join('benchmarks', modality, `${slugify(name)}.json`),
      record: {
        schema_version: '1.0.0',
        record_type: 'benchmark',
        benchmark_id: `${slugify(name)}-${year}`,
        benchmark_name: name,
        primary_modality: modality,
        secondary_modalities: [],
        scope_status: 'pending_review',
        paper: { title, authors, latest_version: latest, reviewed_on: today },
        evaluated_memory_capabilities: [],
        tasks: [],
        evidence,
        review_status: 'community_submitted',
        adjudication_notes: [note],
      },
    };
  }

  const leaves = list(c['Representation'], LEAF);
  const storage = list(c['Storage / indexing'], STORAGE);
  const retrieval = list(c['Retrieval / activation'], RETRIEVAL);
  const tier = ((c['Suggested tier'] || '').match(/\bT[123]\b/) || [])[0] || 'unclear';
  const families = [...new Set(leaves.map((l) => FAMILY_OF[l]))];
  return {
    relPath: path.join('architectures', modality, `${slugify(name)}.json`),
    record: {
      schema_version: '1.0.0',
      record_type: 'architecture',
      architecture_id: `${slugify(name)}-${year}`,
      architecture_name: name,
      primary_modality: modality,
      secondary_modalities: list(c['Secondary modalities'], MODALITY),
      provenance: { paper_title: title, authors, latest_version: latest, reviewed_on: today, supersedes_or_extends: [] },
      representation_paths: leaves.map((leaf, i) => ({
        path_id: `path_${i + 1}`,
        memory_component: 'to be described by maintainers',
        leaf,
        storage_indexing: storage.length ? storage : ['unclear'],
        retrieval_activation: retrieval.length ? retrieval : ['unclear'],
        source_accessibility: 'unclear',
        evidence,
      })),
      t2_operations: [],
      t3_policy_evolution_targets: list(c['T3 policy targets'], T3).map((leaf) => ({ leaf, evidence })),
      derived: {
        representation_parent_families: families,
        cross_representation_hybrid: families.length > 1,
        hybrid_relation: '',
        highest_management_tier: tier,
      },
      review_status: 'community_submitted',
      adjudication_notes: [note, ...(c['T2 operations'] && c['T2 operations'] !== 'not specified' ? [`Submitter-suggested T2 operations: ${c['T2 operations']}.`] : [])],
    },
  };
}

/** Avoid overwriting an existing record. */
function freePath(root, rel) {
  if (!fs.existsSync(path.join(root, rel))) return rel;
  const ext = path.extname(rel);
  for (let i = 2; i < 100; i++) {
    const alt = rel.slice(0, -ext.length) + `-${i}` + ext;
    if (!fs.existsSync(path.join(root, alt))) return alt;
  }
  throw new Error(`No free file name for ${rel}`);
}

module.exports = { sections, classification, buildRecord, parseArxiv, fetchMeta, freePath };

if (require.main === module) {
  (async () => {
    const body = fs.readFileSync(process.argv[2], 'utf8');
    const id = ((sections(body)['arXiv link'] || '').match(/(\d{4}\.\d{4,5})/) || [])[1];
    const arxiv = await fetchMeta(id);
    const { record, relPath } = buildRecord({ body, number: Number(process.argv[3] || 0), arxiv, today: new Date().toISOString().slice(0, 10) });
    console.log(relPath);
    console.log(JSON.stringify(record, null, 2));
  })();
}
