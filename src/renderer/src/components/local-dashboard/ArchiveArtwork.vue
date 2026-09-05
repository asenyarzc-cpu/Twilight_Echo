<script setup lang="ts">
import CoverImg from '@renderer/components/CoverImg.vue'

defineProps<{
  cover?: string | null
  coverSource?: string | null
  identity?: string
  title: string
}>()
</script>

<template>
  <span class="archive-artwork">
    <span class="archive-artwork-placeholder" aria-hidden="true">
      <span class="archive-artwork-grooves"></span>
      <span class="archive-artwork-letter">{{ title.slice(0, 1) || '♪' }}</span>
      <span class="archive-artwork-label">TWILIGHT RECORDS</span>
    </span>
    <CoverImg
      v-if="cover || coverSource"
      :cover="cover"
      :cover-source="coverSource"
      :identity="identity"
      fallback=""
      alt=""
    />
  </span>
</template>

<style scoped>
.archive-artwork {
  --archive-artwork-ink: var(--te-neutral-900);
  --archive-artwork-end: var(--te-neutral-200);
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--te-primary-300);
}
:global(html[data-theme='dark'] .archive-artwork) {
  --archive-artwork-ink: var(--te-neutral-50);
  --archive-artwork-end: var(--te-primary-500);
}
.archive-artwork :deep(img) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.archive-artwork-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: var(--archive-artwork-ink);
  background: linear-gradient(145deg, var(--te-primary-300), var(--archive-artwork-end));
}
.archive-artwork-grooves {
  position: absolute;
  width: 130%;
  aspect-ratio: 1;
  left: 22%;
  top: 12%;
  border-radius: 50%;
  background: repeating-radial-gradient(
    circle,
    transparent 0 7px,
    color-mix(in srgb, var(--te-primary-500) 22%, transparent) 8px 9px
  );
}
.archive-artwork-letter {
  position: relative;
  font-family: var(--te-font-display);
  font-size: clamp(32px, 5vw, 70px);
  font-weight: 500;
}
.archive-artwork-label {
  position: absolute;
  bottom: 9%;
  left: 9%;
  font-size: 8px;
  letter-spacing: 0.2em;
}
</style>
