#[path = "../src/app.rs"]
#[allow(dead_code)]
mod app;

use std::{env, time::Instant};

use app::{TranscriptItem, TranscriptWindow};

fn percentile(samples: &mut [f64], percentile: f64) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[((samples.len() - 1) as f64 * percentile).round() as usize]
}

fn main() {
    let columns = env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(80_u16);
    let rows = env::args()
        .nth(2)
        .and_then(|value| value.parse().ok())
        .unwrap_or(24_u16);
    let mut transcript = TranscriptWindow::default();
    transcript.extend_page((0..10_000).map(|id| TranscriptItem {
        id,
        text: format!("assistant {id} 中文 transcript row"),
    }));
    let mut frames = Vec::new();
    for _ in 0..300 {
        let start = Instant::now();
        transcript.scroll_by(1);
        let _visible = transcript.cached_items().min(usize::from(rows));
        frames.push(start.elapsed().as_secs_f64() * 1_000.0);
    }
    let p50 = percentile(&mut frames.clone(), 0.50);
    let p95 = percentile(&mut frames.clone(), 0.95);
    let p99 = percentile(&mut frames.clone(), 0.99);
    let max = frames.iter().copied().fold(0.0_f64, f64::max);
    println!(
        "{{\"implementation\":\"rust-b0\",\"viewport\":\"{columns}x{rows}\",\"scenario\":\"scroll\",\"p50Ms\":{p50:.6},\"p95Ms\":{p95:.6},\"p99Ms\":{p99:.6},\"maxMs\":{max:.6},\"bytes\":0,\"frames\":300,\"idleFrames\":0,\"rssBytes\":null}}"
    );
}
