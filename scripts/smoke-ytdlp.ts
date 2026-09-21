// Smoke test Fase 0.5 — lane YouTube keyless via yt-dlp di container Clapclip.
import { makeYtdlpLane } from '../src/lanes/ytdlp';

const lane = makeYtdlpLane({
  dockerContainer: process.env.LOCALAPPDATA + '/Programs/DockerDesktop/resources/bin/docker.exe',
  dockerExecArgs: ['exec', 'openshorts-backend'],
  results: 5,
});

const items = await lane.fetch('gadget review', { days: 7 });
console.log('SMOKE_OK items:', items.length);
console.log('contoh:', items[0].title, '|', items[0].snippet);
