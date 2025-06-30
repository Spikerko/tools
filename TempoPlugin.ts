import type { DynamicBackground, DynamicBackgroundOptions, DynamicBackgroundPlugin } from "./DynamicBackground.ts";
import type { Signal } from "@socali/modules/Signal"
import { Maid } from "@socali/modules/Maid";

export type ProcessedSection = {
    start: number;
    end: number;
    duration: number;
    tempo: number;
    speed: number;
};

export type ProcessedSections = Array<ProcessedSection>;

export default class TempoPlugin implements DynamicBackgroundPlugin {
    public name: string = "TempoPlugin";

    private maid: Maid = new Maid();

    private SongChangeSignal: Signal | undefined;
    private getSongId: (() => string) | undefined;
    private getSongPosition: (() => number) | undefined;
    // deno-lint-ignore no-explicit-any
    private GetCosmosAsync: any;
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

    private options: {
        SongChangeSignal: Signal,
        getSongId: () => string,
        getPaused: () => boolean;
        getSongPosition: () => number,
        // deno-lint-ignore no-explicit-any
        GetCosmosAsync: any
    }

    constructor(options: {
        SongChangeSignal: Signal,
        getSongId: () => string,
        getPaused: () => boolean;
        getSongPosition: () => number,
        // deno-lint-ignore no-explicit-any
        GetCosmosAsync: any
    }) {
        this.maid.Give(() => this.audioDataCache.clear());
        this.options = options;
        this.SongChangeSignal = this.maid.Give(this.options.SongChangeSignal);
        this.getSongId = this.options.getSongId;
        this.getSongPosition = this.options.getSongPosition;
        this.GetCosmosAsync = this.options.GetCosmosAsync;
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
                await this.processSections();
                if (this.processedSections && !this.speedAnimation) {
                    this.animate();
                }
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
        this.SongChangeSignal?.Connect(initiateProcess);
    }
    public isInitialized() {
        return this.initialized
    }

    private async getAudioData() {
        if (!this.initialized) throw new Error("TempoPlugin hasn't been initialized yet");
        if (!this.getSongId) throw new Error("TempoPlugin: getSongId() is undefined");
        const songId = this.getSongId();
        
        if (this.audioDataCache.has(songId)) {
            return this.audioDataCache.get(songId);
        }

        if (!this.GetCosmosAsync) throw new Error("TempoPlugin: GetCosmosAsync() is undefined");
        try {
            const res = await this.GetCosmosAsync()?.get(`https://api.spotify.com/v1/audio-analysis/${songId}`);
            if (!res) throw new Error("TempoPlugin: CosmosAsync request failed");
            this.audioDataCache.set(songId, res);
            return res;
        } catch {
            throw new Error("TempoPlugin: Getting Audio Data failed")
        }
    }

    private async processSections() {
        const audioData = await this.getAudioData();

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
            if (this.lastSpeed !== section.speed && !this.getPaused()) {
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
        this.maid.Give(() => {
            if (this.speedAnimation) {
                cancelAnimationFrame(this.speedAnimation);
                this.speedAnimation = undefined;
            }
        });
    }

    public Destroy() {
        this.initialized = false;
        this.maid.Destroy();
    }
}