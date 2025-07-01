import type { DynamicBackground, DynamicBackgroundOptions, DynamicBackgroundPlugin, DynamicBackgroundPluginTuple } from "./DynamicBackground.ts";
import type { Signal } from "@socali/modules/Signal"
import { Maid } from "@socali/modules/Maid";
import { GetExpireStore } from "./Cache.ts";

export type ProcessedSection = {
    start: number;
    end: number;
    duration: number;
    tempo: number;
    speed: number;
};

export type ProcessedSections = Array<ProcessedSection>;

const AudioDataStore = GetExpireStore<ProcessedSections>(
    "SpikerkoTools_TempoPlugin_AudioData",
    1,
    {
        Unit: "Weeks",
        Duration: 2
    }
)

export type TempoPluginOptions = {
    SongChangeSignal: Signal,
    getSongId: () => string,
    getPaused: () => boolean;
    getSongPosition: () => number,
    getAccessToken: () => Promise<string>,
};

export class TempoPlugin implements DynamicBackgroundPlugin {
    public name: string = "TempoPlugin";

    private maid: Maid = new Maid();

    private SongChangeSignal: Signal | undefined;
    private getSongId: (() => string) | undefined;
    private getSongPosition: (() => number) | undefined;
    
    private getAccessToken: () => Promise<string> | undefined;
    private dynamicBg: DynamicBackground | undefined;

    private initialized: boolean = false;
    // deno-lint-ignore no-explicit-any
    private audioDataCache: Map<string, any> = new Map();

    private speedAnimation: number | undefined;
    private speedAnimationFunction: (() => void | undefined) | undefined;
    private processedSections: ProcessedSections | undefined;

    private lastPaused: boolean = false;
    private lastSpeed: number = 0;
    
    private getPaused: (() => boolean) | undefined;
    private clientOptions: DynamicBackgroundOptions | undefined;

    private audioDataAbortController: AbortController | undefined;

    private options: TempoPluginOptions

    constructor(options: TempoPluginOptions) {
        this.maid.Give(() => {
            this.audioDataCache.clear()
            this.audioDataAbortController?.abort();
        });
        this.options = options;
        this.SongChangeSignal = this.options.SongChangeSignal;
        this.getSongId = this.options.getSongId;
        this.getSongPosition = this.options.getSongPosition;
        this.getAccessToken = this.options.getAccessToken;
        this.getPaused = this.options.getPaused;
        this.animationLoop = this.animationLoop.bind(this);
    }

    public async initialize(options: {
        ClientOptions: DynamicBackgroundOptions
        InternalContent: DynamicBackground,
    }) {
        if (this.initialized) throw new Error("TempoPlugin was already initialized");
        
        this.dynamicBg = options.InternalContent;
        this.clientOptions = options.ClientOptions;

        this.lastSpeed = this.dynamicBg.rotationSpeed ?? 0;
        this.initialized = true;

        const initiateProcess = async () => {
            try {
                this.processedSections = undefined;
                await this.processSections();
                this.animate();
            } catch (error) {
                console.error("TempoPlugin: Failed to process song sections. Animation not started.", error);
                if (this.speedAnimation) {
                    cancelAnimationFrame(this.speedAnimation);
                    this.speedAnimation = undefined;
                }
                this.processedSections = undefined;
            }
        };
        setTimeout(() => {
            initiateProcess();
        }, 50)

        const conn = this.SongChangeSignal?.Connect(initiateProcess);
        this.maid.Give(() => conn?.Disconnect());
    }
    public isInitialized() {
        return this.initialized
    }

    private async getAudioData() {
        if (!this.initialized) throw new Error("TempoPlugin hasn't been initialized yet");
        if (!this.getSongId) throw new Error("TempoPlugin: getSongId() is undefined");
        const songId = this.getSongId();

        this.audioDataAbortController?.abort();
        this.audioDataAbortController = new AbortController();

        const isMapCached = this.audioDataCache.has(songId);
        if (isMapCached) {
            return this.audioDataCache.get(songId)
        }
        
        const cached = await AudioDataStore.GetItem(songId);
        if (cached) {
            return cached;
        }
        
        const signal = this.audioDataAbortController.signal;

        if (!this.getAccessToken) throw new Error("TempoPlugin: getAccessToken() is undefined");
        const accessToken = await this.getAccessToken();
        if (!accessToken) throw new Error("TempoPlugin: Access Token missing")
        try {
            const req = await fetch(`https://api.spotify.com/v1/audio-analysis/${songId}`, {
                method: "GET",
                headers: {
                    Authorization: accessToken
                },
                signal
            });
            if (req.status !== 200) {
                throw new Error("TempoPlugin: Fetch request failed");
            }
            const res = await req.json();
            if (!res) throw new Error("TempoPlugin: Fetch request failed - content missing");
            this.audioDataCache.set(songId, res);
            await AudioDataStore.SetItem(songId, res);
            this.audioDataAbortController = undefined;
            return res;
        // deno-lint-ignore no-explicit-any
        } catch (err: any) {
            if (err.name === 'AbortError') {
                console.warn('TempoPlugin: Previous getAudioData request aborted');
                return;
            }
            this.audioDataAbortController = undefined;
            throw new Error("TempoPlugin: Getting Audio Data failed")
        }
    }

    private async processSections() {
        const audioData = await this.getAudioData();

        if (!audioData) {
            this.processedSections = undefined;
            return;
        }

        // deno-lint-ignore no-explicit-any
        const tempos = audioData.sections.map((s: { tempo: any; }) => s.tempo);
        const minTempo = Math.min(...tempos);
        const maxTempo = Math.max(...tempos);
        const tempoRange = maxTempo - minTempo;

        // deno-lint-ignore no-explicit-any
        this.processedSections = audioData?.sections?.map((section: { tempo: number; start: any; duration: any; }, index: number, arr: { [x: string]: { start: any; }; }) => {
            const newMinSpeed = 0.2;
            const newMaxSpeed = 0.55;

            let speed;
            if (tempoRange === 0) {
                speed = newMinSpeed;
            } else {
                speed = newMinSpeed + (newMaxSpeed - newMinSpeed) * (section.tempo - minTempo) / tempoRange;
            }

            return {
                start: section.start,
                end: arr?.[index + 1]?.start ?? (section.start + section.duration),
                duration: section.duration,

                tempo: section.tempo,
                speed,
            }
        }) as ProcessedSections;
    }

    private async animationLoop() {
        if (!this.getSongPosition) {
          console.error("TempoPlugin: getSongPosition() is undefined");
          throw new Error("TempoPlugin: getSongPosition() is undefined");
        }
        if (!this.processedSections) {
          console.warn("TempoPlugin: this.processedSections is undefined, skipping frame.");
          this.speedAnimation = requestAnimationFrame(this.animationLoop);
          return;
        }
        const audioPosition = this.getSongPosition();
        for (const section of this.processedSections) {
          const start = section.start;
          const end = section.end;
          const isActive = audioPosition >= start && audioPosition < end;
          if (isActive) {
            if (!this.getPaused) {
              console.error("TempoPlugin: getPaused() is undefined");
              throw new Error("TempoPlugin: getPaused() is undefined");
            }
            if (!this.dynamicBg) {
              console.error("TempoPlugin: dynamicBg() is undefined");
              throw new Error("TempoPlugin: dynamicBg() is undefined");
            }
            if (this.lastPaused !== this.getPaused()) {
              await this.dynamicBg.Update({
                speed: 0,
              });
              this.lastSpeed = -1;
            }
            this.lastPaused = this.getPaused();
            if (this.lastSpeed !== section.speed && !this.lastPaused) {
              await this.dynamicBg.Update({
                speed: section.speed,
              });
            }
            this.lastSpeed = section.speed;
            break;
          }
        }
        this.speedAnimation = requestAnimationFrame(this.animationLoop);
      }

    private animate() {
        if (this.speedAnimation) {
            console.error("TempoPlugin: Speed animation is already running");
            return;
        }
        this.speedAnimation = requestAnimationFrame(this.animationLoop);
    }

    public Destroy() {
        this.initialized = false;
        this.lastSpeed = -1;
        this.lastPaused = false;
        this.processedSections = undefined;
        this.audioDataAbortController?.abort();
        this.audioDataAbortController = undefined;
        if (this.speedAnimation) {
            cancelAnimationFrame(this.speedAnimation);
            this.speedAnimation = undefined;
        }
        this.maid.Destroy();
    }
}

export default function(options: TempoPluginOptions): DynamicBackgroundPluginTuple {
    return [TempoPlugin, options];
}