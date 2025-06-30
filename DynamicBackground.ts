import * as THREE from "jsr:@3d/three@0.166.0";
//import * as THREE from "@3d/three";
// deno-lint-ignore verbatim-module-syntax
import { GetShaderUniforms, VertexShader, FragmentShader, type ShaderUniforms, DisposeShaderUniforms } from "./DBG_ThreeShaders.ts";
// deno-lint-ignore verbatim-module-syntax
import { Maid, Giveable } from "@socali/modules/Maid";
import PrefixError from "./PrefixError.ts";

export type CoverArtCache = Map<string, OffscreenCanvas>;

export type DynamicBackgroundPlugin = { 
    // deno-lint-ignore no-explicit-any
    //new (...args: any[]): {
        name: string;
        // deno-lint-ignore no-explicit-any
        initialize: (...args: any[]) => Promise<void>;
    //};
} & Giveable;

export type DynamicBackgroundPlugins = Record<string, DynamicBackgroundPlugin>

// Interface for DynamicBackground constructor options
export interface DynamicBackgroundOptions {
    transition?: number | boolean;
    blur?: number;
    maid?: Maid;
    speed?: number;
    coverArtCache?: CoverArtCache;
    plugins?: DynamicBackgroundPlugins
}

// Interface for Update method options
export interface DynamicBackgroundUpdateOptions {
    image: string;
    placeholderHueShift?: number;
    blur?: number;
    speed?: number;
}

const DynamicBackgroundError = new PrefixError({
    name: "DynamicBackgroundError",
    prefix: "DynamicBackground: "
}).Create();

/**
 * DynamicBackground class that implements Giveable interface
 * Creates and manages a THREE.js canvas with animated background
 */
export class DynamicBackground implements Giveable {
    // public properties
    public container: HTMLElement & {
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        uniforms: ShaderUniforms;
        texture?: THREE.Texture;
        material?: THREE.ShaderMaterial;
        animationFrameId?: number;
    };
    public maid: Maid;
    public resizeObserver?: ResizeObserver;
    public blurAmount: number;
    public transitionDuration: number;
    public rotationSpeed: number;
    public rotationAngle: number = 0;
    public lastFrameTime: number = 0;

    // Track current values for change detection
    public currentImage?: string;
    public currentPlaceholderHueShift: number = 0;

    // THREE.js objects that were previously static
    public renderCamera!: THREE.OrthographicCamera;
    public meshGeometry!: THREE.PlaneGeometry;

    // Cache for blurred cover arts
    public blurredCoverArts: Map<string, OffscreenCanvas>;

    // deno-lint-ignore no-explicit-any
    public plugins: DynamicBackgroundPlugins | Array<any>;

    /**
     * Creates a new DynamicBackground
     * @param options Configuration options
     */
    constructor(options: DynamicBackgroundOptions = {}) {
        // Convert plugins array or object to a normalized object with plugin names as keys
        const pluginsInput = options.plugins ?? [];
        // deno-lint-ignore no-explicit-any
        let pluginsObj: Record<string, any> = {};

        if (Array.isArray(pluginsInput)) {
            for (const plugin of pluginsInput) {
                // Ensure plugin is an object and has a string 'name' property
                if (plugin && typeof plugin === "object" && typeof (plugin as { name?: unknown }).name === "string") {
                    pluginsObj[(plugin as { name: string }).name] = plugin;
                }
            }
        } else if (typeof pluginsInput === "object" && pluginsInput !== null) {
            // If already an object, shallow copy
            pluginsObj = { ...pluginsInput };
        }

        this.plugins = pluginsObj;

        // Set default values
        this.blurAmount = options.blur ?? 40;
        this.rotationSpeed = options.speed ?? 0.2;

        this.blurredCoverArts = options.coverArtCache ?? new Map();

        // Handle transition option (can be boolean or number)
        if (typeof options.transition === 'boolean') {
            this.transitionDuration = options.transition ? 0.5 : 0;
        } else {
            this.transitionDuration = options.transition ?? 0.5;
        }

        // Create or use provided maid
        this.maid = options.maid ?? new Maid();

        // Initialize THREE.js objects
        this.initThreeObjects();

        // Register THREE.js geometry with Maid
        this.maid.Give(() => {
            if (this.meshGeometry) {
                this.meshGeometry.dispose();
            }
        });

        // Create the renderer
        const renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: true,
            powerPreference: 'default',
            preserveDrawingBuffer: false
        });

        // Setup container
        this.container = renderer.domElement as typeof this.container;

        // Create scene and materials
        const renderScene = new THREE.Scene();
        const materialUniforms = GetShaderUniforms();
        const meshMaterial = new THREE.ShaderMaterial({
            uniforms: materialUniforms,
            vertexShader: VertexShader,
            fragmentShader: FragmentShader,
        });

        this.container.material = meshMaterial;

        // Create mesh and add to scene
        const sceneMesh = new THREE.Mesh(
            this.meshGeometry,
            meshMaterial as unknown as THREE.MeshBasicMaterial
        );
        renderScene.add(sceneMesh);

        // Set container properties
        this.container.renderer = renderer;
        this.container.scene = renderScene;
        this.container.uniforms = materialUniforms;

        // Set initial rotation speed
        this.container.uniforms.RotationSpeed.value = this.rotationSpeed;

        // Register renderer cleanup with Maid
        this.maid.Give(() => {
            if (this.container.renderer) {
                this.container.renderer.dispose();
                const gl = this.container.renderer.getContext();
                if (gl && !gl.isContextLost()) {
                    const loseContext = gl.getExtension('WEBGL_lose_context');
                    if (loseContext) loseContext.loseContext();
                }
                this.container.renderer = undefined as unknown as THREE.WebGLRenderer;
            }
        });

        // Register material cleanup with Maid
        this.maid.Give(() => {
            if (this.container.material) {
                this.container.material.dispose();
                this.container.material = undefined;
            }
        });

        // Register texture cleanup with Maid
        this.maid.Give(() => {
            if (this.container.texture) {
                this.container.texture.dispose();
                this.container.texture = undefined;
            }
        });

        // Register shader uniforms cleanup with Maid
        this.maid.Give(() => {
            if (this.container.uniforms) {
                DisposeShaderUniforms(this.container.uniforms);
            }
        });

        // Register animation frame cleanup with Maid
        this.maid.Give(() => {
            if (this.container.animationFrameId) {
                cancelAnimationFrame(this.container.animationFrameId);
                this.container.animationFrameId = undefined;
            }
        });

        // Register DOM element removal with Maid
        this.maid.Give(() => {
            if (this.container.parentElement) {
                this.container.remove();
            }
        });

        // Register blurred cover arts cache cleanup with Maid
        this.maid.Give(() => {
            this.blurredCoverArts.clear();
        });

        // Still keep the comprehensive cleanup as a fallback
        this.maid.Give(() => this.cleanup());

        Object.values(this.plugins).forEach(plugin => {
            if (!plugin) return;
            this.maid.Give(plugin)
            plugin.initialize(
                {
                    ClientOptions: options,
                    InternalContent: this,
                }
            );
        })
    }

    /**
     * Initialize Three.js static objects
     * This is now an instance method that creates objects for this instance only
     */
    public initThreeObjects(): void {
        this.renderCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        (this.renderCamera as unknown as { position: { z: number } }).position.z = 1;
        this.meshGeometry = new THREE.PlaneGeometry(2, 2);
    }

    /**
     * Updates the background with a new image
     * @param options Update options
     * @returns Promise that resolves when the update is complete
     */
    public async Update(options: DynamicBackgroundUpdateOptions): Promise<void> {
        // Don't update if maid is destroyed
        if (this.maid.IsDestroyed()) return;

        const { image, placeholderHueShift = 0, blur = this.blurAmount, speed = this.rotationSpeed } = options;

        if (!image || image === null || image === undefined || typeof image !== 'string') {
            throw new DynamicBackgroundError("Image must be a string");
        }

        // Check if anything has changed
        const imageChanged = image !== this.currentImage;
        const hueShiftChanged = placeholderHueShift !== this.currentPlaceholderHueShift;
        const blurChanged = blur !== this.blurAmount;
        const oldSpeed = this.rotationSpeed;
        const speedChanged = speed !== oldSpeed;

        // If nothing has changed, return early
        if (!imageChanged && !hueShiftChanged && !blurChanged && !speedChanged) {
            return;
        }

        // Update stored values
        this.blurAmount = blur;
        this.rotationSpeed = speed;
        this.currentImage = image;
        this.currentPlaceholderHueShift = placeholderHueShift;

        // If no current texture, initialize it
        if (!this.container.texture) {
            await this.initializeTexture(image, placeholderHueShift);
            return;
        }

        // Cancel any existing animation frame
        if (this.container.animationFrameId) {
            cancelAnimationFrame(this.container.animationFrameId);
            this.container.animationFrameId = undefined;
        }

        // Get the new blurred cover art
        const newBlurredCover = await this.getBlurredCoverArt(image, placeholderHueShift);

        // Create a new texture
        const newTexture = new THREE.CanvasTexture(newBlurredCover);
        newTexture.minFilter = THREE.NearestFilter;
        newTexture.magFilter = THREE.NearestFilter;
        newTexture.needsUpdate = true;

        // Dispose of any existing new texture
        if (this.container.uniforms.NewBlurredCoverArt.value) {
            (this.container.uniforms.NewBlurredCoverArt.value as THREE.Texture).dispose();
        }

        // Set the new texture
        this.container.uniforms.NewBlurredCoverArt.value = newTexture;
        this.container.uniforms.RotationSpeed.value = oldSpeed;

        // Force a render to ensure the texture is loaded before starting the animation
        if (this.container.renderer && this.container.scene) {
            this.container.renderer.render(this.container.scene, this.renderCamera);
        }

        // Reset transition progress
        this.container.uniforms.TransitionProgress.value = 0;

        // Skip animation if transition duration is 0
        if (this.transitionDuration <= 0) {
            this.completeTransition(newTexture, image);
            return;
        }

        // Animate the transition
        await this.animateTransition(newTexture, image, oldSpeed);
    }

    /**
     * Returns the canvas element for external use
     * @returns HTMLElement containing the THREE.js canvas
     */
    public GetCanvasElement(): HTMLElement {
        return this.container;
    }

    /**
     * Destroys the background and cleans up all resources
     */
    public Destroy(): void {
        // Check if maid is already destroyed
        if (this.maid.IsDestroyed()) {
            this.cleanup();
            return;
        }

        // Run cleanup regardless of maid ownership
        // This ensures all resources are properly cleaned up
        this.cleanup();

        // Always destroy the maid, regardless of ownership
        // This is important for proper resource cleanup
        this.maid.Destroy();
    }

    /**
     * Initializes the texture for the first time
     * @param imageCoverUrl URL of the image to use
     * @param placeholderHueShift Optional hue shift for placeholder images
     */
    public async initializeTexture(imageCoverUrl: string, placeholderHueShift: number = 0): Promise<void> {
        const blurredCover = await this.getBlurredCoverArt(imageCoverUrl, placeholderHueShift);
        const texture = new THREE.CanvasTexture(blurredCover);
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;

        this.container.texture = texture;
        this.container.uniforms.BlurredCoverArt.value = texture;
        this.container.uniforms.Time.value = 0;
        this.container.uniforms.RotationSpeed.value = this.rotationSpeed;
        this.container.setAttribute("data-cover-id", imageCoverUrl);

        // Store current values for change detection
        this.currentImage = imageCoverUrl;
        this.currentPlaceholderHueShift = placeholderHueShift;
    }

    /**
     * Animates the transition between textures
     * @param newTexture The new texture to transition to
     * @param newCoverArtUrl URL of the new cover art
     */
    public animateTransition(newTexture: THREE.Texture, newCoverArtUrl: string, oldSpeed: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const newSpeed = this.rotationSpeed;
            const duration = this.transitionDuration * 1000;
            let startTime: number | null = null;

            const animationState = { canceled: false, frameId: 0 };

            let cleanupKey: unknown;
            if (!this.maid.IsDestroyed()) {
                cleanupKey = this.maid.Give(() => {
                    animationState.canceled = true;
                    cancelAnimationFrame(animationState.frameId);
                    if (this.container.uniforms) {
                        this.container.uniforms.TransitionProgress.value = 0;
                        this.container.uniforms.RotationSpeed.value = this.rotationSpeed;
                    }
                });
            }

            this.lastFrameTime = performance.now();
            const animate = (timestamp: number) => {
                if (animationState.canceled) {
                    resolve();
                    return;
                }

                if (startTime === null) {
                    startTime = timestamp;
                }

                const elapsedTime = timestamp - startTime;
                const progress = Math.min(elapsedTime / duration, 1);

                const deltaTime = (timestamp - this.lastFrameTime) / 1000;
                this.lastFrameTime = timestamp;

                const animatedSpeed = oldSpeed + (newSpeed - oldSpeed) * progress;
                this.rotationAngle += deltaTime * animatedSpeed;
                
                this.container.uniforms.RotationAngle.value = this.rotationAngle;
                this.container.uniforms.TransitionProgress.value = progress;

                if (this.container.renderer && this.container.scene) {
                    this.container.renderer.render(this.container.scene, this.renderCamera);
                }

                if (progress < 1) {
                    animationState.frameId = requestAnimationFrame(animate);
                } else {
                    if (animationState.canceled) {
                        resolve();
                        return;
                    }

                    this.completeTransition(newTexture, newCoverArtUrl);

                    if (cleanupKey !== undefined && !this.maid.IsDestroyed()) {
                        this.maid.Clean(cleanupKey);
                    }

                    resolve();
                }
            };

            animationState.frameId = requestAnimationFrame(animate);
        });
    }

    /**
     * Completes the transition by swapping textures
     * @param newTexture The new texture to use
     * @param newCoverArtUrl URL of the new cover art
     */
    public completeTransition(newTexture: THREE.Texture, newCoverArtUrl: string): void {
        // When animation is complete, swap textures
        if (this.container.texture) {
            this.container.texture.dispose();
        }

        this.container.texture = newTexture;
        this.container.uniforms.BlurredCoverArt.value = newTexture;
        this.container.uniforms.NewBlurredCoverArt.value = null;
        this.container.uniforms.TransitionProgress.value = 0;
        this.container.uniforms.RotationSpeed.value = this.rotationSpeed;
        this.container.setAttribute("data-cover-id", newCoverArtUrl);

        // Update current image for change detection
        this.currentImage = newCoverArtUrl;

        // Force a render to ensure the new texture is displayed
        if (this.container.renderer && this.container.scene) {
            this.container.renderer.render(this.container.scene, this.renderCamera);
        }

        // Start animation loop
        this.startAnimation();
    }

    /**
     * Starts the animation loop
     */
    public startAnimation(): void {
        // Cancel any existing animation
        if (this.container.animationFrameId) {
            cancelAnimationFrame(this.container.animationFrameId);
            this.container.animationFrameId = undefined;
        }

        this.lastFrameTime = performance.now();
        const animate = (time: number) => {
            // Check if container and renderer still exist
            if (!this.container || !this.container.renderer || this.container.renderer.getContext()?.isContextLost()) {
                if (this.container?.animationFrameId) {
                    cancelAnimationFrame(this.container.animationFrameId);
                    this.container.animationFrameId = undefined;
                }
                return;
            }

            // Check if renderCamera exists (it might have been cleaned up)
            if (!this.renderCamera) return;

            const deltaTime = (time - this.lastFrameTime) / 1000;
            this.lastFrameTime = time;

            this.rotationAngle += deltaTime * this.rotationSpeed;
            this.container.uniforms.RotationAngle.value = this.rotationAngle;

            this.container.renderer.render(this.container.scene, this.renderCamera);
            this.container.animationFrameId = requestAnimationFrame(animate);
        };

        animate(performance.now());
    }

    /**
     * Updates the container dimensions when parent element size changes
     * @param width New width
     * @param height New height
     */
    public updateContainerDimensions(width: number, height: number): void {
        const { renderer, scene, uniforms } = this.container;

        renderer.setSize(width, height);
        renderer.setPixelRatio(globalThis.devicePixelRatio);

        const scaledWidth = (width * globalThis.devicePixelRatio);
        const scaledHeight = (height * globalThis.devicePixelRatio);

        const largestAxis = ((scaledWidth > scaledHeight) ? "X" : "Y");
        const largestAxisSize = ((scaledWidth > scaledHeight) ? scaledWidth : scaledHeight);

        uniforms.BackgroundCircleOrigin.value.set(scaledWidth / 2, scaledHeight / 2);
        uniforms.BackgroundCircleRadius.value = largestAxisSize * 1.5;
        uniforms.CenterCircleOrigin.value.set(scaledWidth / 2, scaledHeight / 2);
        uniforms.CenterCircleRadius.value = largestAxisSize * (largestAxis === "X" ? 1 : 0.75);
        uniforms.LeftCircleOrigin.value.set(0, scaledHeight);
        uniforms.LeftCircleRadius.value = largestAxisSize * 0.75;
        uniforms.RightCircleOrigin.value.set(scaledWidth, 0);
        uniforms.RightCircleRadius.value = largestAxisSize * (largestAxis === "X" ? 0.65 : 0.5);

        renderer.render(scene, this.renderCamera);
        this.startAnimation();
    }

    /**
     * Appends the background to a parent element
     * @param element Parent element to append the background to
     */
    public AppendToElement(element: HTMLElement): void {
        // Don't append if maid is destroyed
        if (this.maid.IsDestroyed()) return;

        // Remove from current parent if any
        if (this.container.parentElement) {
            this.container.remove();
        }

        // Disconnect existing resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = undefined;
        }

        // Add to new parent
        element.appendChild(this.container);

        // Create new resize observer
        this.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const width = Math.max(entry.contentRect.width, 500);
                const height = Math.max(entry.contentRect.height, 500);
                this.updateContainerDimensions(width, height);
            }
        });

        // Add to maid for proper cleanup if maid is not destroyed
        if (!this.maid.IsDestroyed()) {
            this.maid.Give(() => {
                if (this.resizeObserver) {
                    this.resizeObserver.disconnect();
                    this.resizeObserver = undefined;
                }
            });
        }

        // Start observing
        this.resizeObserver.observe(element);

        // Initial size update
        const width = Math.max(element.clientWidth, 500);
        const height = Math.max(element.clientHeight, 500);
        this.updateContainerDimensions(width, height);
    }

    /**
     * Gets a blurred cover art from the URL
     * @param coverArtUrl URL of the cover art
     * @param placeholderHueShift Optional hue shift for placeholder images
     * @returns Promise that resolves to an OffscreenCanvas with the blurred image
     */
    public async getBlurredCoverArt(coverArtUrl: string, placeholderHueShift: number = 0): Promise<OffscreenCanvas> {
        if (this.blurredCoverArts.has(coverArtUrl)) {
            return this.blurredCoverArts.get(coverArtUrl)!;
        }

        const image = new Image();
        image.src = coverArtUrl;
        if (coverArtUrl.includes("https://") || coverArtUrl.includes("http://")) {
            image.crossOrigin = "anonymous";
        }
        await image.decode();

        const originalSize = Math.min(image.width, image.height);
        const resizedBlurAmount = this.blurAmount * (originalSize / 640);
        const blurExtent = Math.ceil(3 * resizedBlurAmount);

        const circleCanvas = new OffscreenCanvas(originalSize, originalSize);
        const circleCtx = circleCanvas.getContext('2d')!;

        circleCtx.beginPath();
        circleCtx.arc(originalSize / 2, originalSize / 2, originalSize / 2, 0, Math.PI * 2);
        circleCtx.closePath();
        circleCtx.clip();

        circleCtx.drawImage(
            image,
            ((image.width - originalSize) / 2), ((image.height - originalSize) / 2),
            originalSize, originalSize,
            0, 0,
            originalSize, originalSize
        );

        const padding = (blurExtent * 1.5);
        const expandedSize = originalSize + padding;
        const blurredCanvas = new OffscreenCanvas(expandedSize, expandedSize);
        const blurredCtx = blurredCanvas.getContext('2d')!;

        blurredCtx.filter = `blur(${resizedBlurAmount}px) hue-rotate(${placeholderHueShift}deg)`;
        blurredCtx.drawImage(circleCanvas, (padding / 2), (padding / 2));

        this.blurredCoverArts.set(coverArtUrl, blurredCanvas);
        return blurredCanvas;
    }

    /**
     * Cleans up all resources used by the background
     * This is a fallback cleanup method in case individual Maid cleanups fail
     */
    public cleanup(): void {
        // Disconnect resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = undefined;
        }

        // Cancel animation frame
        if (this.container.animationFrameId) {
            cancelAnimationFrame(this.container.animationFrameId);
            this.container.animationFrameId = undefined;
        }

        // Dispose of shader uniforms
        if (this.container.uniforms) {
            DisposeShaderUniforms(this.container.uniforms);
        }

        // Dispose of material
        if (this.container.material) {
            this.container.material.dispose();
            this.container.material = undefined;
        }

        // Dispose of texture
        if (this.container.texture) {
            this.container.texture.dispose();
            this.container.texture = undefined;
        }

        // Clean up scene
        if (this.container.scene) {
            // Dispose all objects in the scene
            this.container.scene.traverse((object: THREE.Object3D) => {
                if (object instanceof THREE.Mesh) {
                    if (object.geometry) object.geometry.dispose();
                    if (object.material) {
                        if (Array.isArray(object.material)) {
                            object.material.forEach((material: THREE.Material) => material.dispose());
                        } else {
                            object.material.dispose();
                        }
                    }
                }
            });
        }

        // Dispose of renderer
        if (this.container.renderer) {
            this.container.renderer.dispose();
            const gl = this.container.renderer.getContext();
            if (gl && !gl.isContextLost()) {
                const loseContext = gl.getExtension('WEBGL_lose_context');
                if (loseContext) loseContext.loseContext();
            }
            this.container.renderer = undefined as unknown as THREE.WebGLRenderer;
        }

        // Remove from parent
        if (this.container) {
            this.container.remove();
        }

        // Clean up THREE.js objects
        if (this.meshGeometry) {
            this.meshGeometry.dispose();
        }

        // Clear the blurred cover arts cache
        this.blurredCoverArts.clear();

        // Reset tracking variables
        this.currentImage = undefined;
        this.currentPlaceholderHueShift = 0;
    }
}