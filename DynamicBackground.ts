import * as THREE from "jsr:@3d/three@0.166.0";
// deno-lint-ignore verbatim-module-syntax
import { GetShaderUniforms, VertexShader, FragmentShader, ShaderUniforms, DisposeShaderUniforms } from "./DBG_ThreeShaders.ts";
// deno-lint-ignore verbatim-module-syntax
import { Maid, Giveable } from "@socali/modules/Maid";

export type CoverArtCache = Map<string, OffscreenCanvas>;

// Interface for DynamicBackground constructor options
export interface DynamicBackgroundOptions {
    transition?: number | boolean;
    blur?: number;
    maid?: Maid;
    speed?: number;
    coverArtCache?: CoverArtCache;
}

// Interface for Update method options
export interface DynamicBackgroundUpdateOptions {
    image: string;
    placeholderHueShift?: number;
    blur?: number;
    speed?: number;
}


/**
 * DynamicBackground class that implements Giveable interface
 * Creates and manages a THREE.js canvas with animated background
 */
export class DynamicBackground implements Giveable {
    // Private properties
    private container: HTMLElement & {
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        uniforms: ShaderUniforms;
        texture?: THREE.Texture;
        material?: THREE.ShaderMaterial;
        animationFrameId?: number;
    };
    private maid: Maid;
    private resizeObserver?: ResizeObserver;
    private blurAmount: number;
    private transitionDuration: number;
    private rotationSpeed: number;

    // Track current values for change detection
    private currentImage?: string;
    private currentPlaceholderHueShift: number = 0;

    // THREE.js objects that were previously static
    private renderCamera!: THREE.OrthographicCamera;
    private meshGeometry!: THREE.PlaneGeometry;

    // Cache for blurred cover arts
    private blurredCoverArts: Map<string, OffscreenCanvas>;

    /**
     * Creates a new DynamicBackground
     * @param options Configuration options
     */
    constructor(options: DynamicBackgroundOptions = {}) {
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
    }

    /**
     * Initialize Three.js static objects
     * This is now an instance method that creates objects for this instance only
     */
    private initThreeObjects(): void {
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

        // Check if anything has changed
        const imageChanged = image !== this.currentImage;
        const hueShiftChanged = placeholderHueShift !== this.currentPlaceholderHueShift;
        const blurChanged = blur !== this.blurAmount;
        const speedChanged = speed !== this.rotationSpeed;

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
        this.container.uniforms.RotationSpeed.value = this.rotationSpeed;

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
        await this.animateTransition(newTexture, image);
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
    private async initializeTexture(imageCoverUrl: string, placeholderHueShift: number = 0): Promise<void> {
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
    private animateTransition(newTexture: THREE.Texture, newCoverArtUrl: string): Promise<void> {
        return new Promise<void>((resolve) => {
            // Use a simple animation approach with setTimeout
            // Just a few steps for a quick, linear crossfade
            const totalSteps = 10; // 10 steps is enough for a short crossfade
            const stepDuration = (this.transitionDuration * 1000) / totalSteps;
            let currentStep = 0;

            // Create a cleanup object to track if animation should be canceled
            const animationState = { canceled: false };

            // Register cleanup with maid if it's not destroyed
            let cleanupKey: unknown;
            if (!this.maid.IsDestroyed()) {
                cleanupKey = this.maid.Give(() => {
                    animationState.canceled = true;
                    if (this.container.uniforms) {
                        this.container.uniforms.TransitionProgress.value = 0;
                        this.container.uniforms.RotationSpeed.value = this.rotationSpeed;
                    }
                });
            }

            // Function to perform one step of the animation
            const performAnimationStep = () => {
                if (animationState.canceled) {
                    resolve();
                    return;
                }

                currentStep++;

                // Simple linear progress
                const progress = currentStep / totalSteps;

                // Update shader uniforms
                this.container.uniforms.TransitionProgress.value = progress;

                // Force render
                if (this.container.renderer && this.container.scene) {
                    this.container.renderer.render(this.container.scene, this.renderCamera);
                }

                // Continue animation if not complete
                if (currentStep < totalSteps && !animationState.canceled) {
                    setTimeout(performAnimationStep, stepDuration);
                } else {
                    // Animation complete
                    if (animationState.canceled) {
                        resolve();
                        return;
                    }

                    this.completeTransition(newTexture, newCoverArtUrl);

                    // Clean up the animation key if it exists and maid is not destroyed
                    if (cleanupKey !== undefined && !this.maid.IsDestroyed()) {
                        this.maid.Clean(cleanupKey);
                    }

                    resolve();
                }
            };

            // Start the animation after a small delay
            setTimeout(performAnimationStep, 50);
        });
    }

    /**
     * Completes the transition by swapping textures
     * @param newTexture The new texture to use
     * @param newCoverArtUrl URL of the new cover art
     */
    private completeTransition(newTexture: THREE.Texture, newCoverArtUrl: string): void {
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
    private startAnimation(): void {
        // Cancel any existing animation
        if (this.container.animationFrameId) {
            cancelAnimationFrame(this.container.animationFrameId);
            this.container.animationFrameId = undefined;
        }

        const animate = () => {
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

            this.container.uniforms.Time.value = performance.now() / 1000;
            this.container.renderer.render(this.container.scene, this.renderCamera);
            this.container.animationFrameId = requestAnimationFrame(animate);
        };

        animate();
    }

    /**
     * Updates the container dimensions when parent element size changes
     * @param width New width
     * @param height New height
     */
    private updateContainerDimensions(width: number, height: number): void {
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
    private async getBlurredCoverArt(coverArtUrl: string, placeholderHueShift: number = 0): Promise<OffscreenCanvas> {
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
        const blurExtent = Math.ceil(3 * this.blurAmount);

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

        blurredCtx.filter = `blur(${this.blurAmount}px) hue-rotate(${placeholderHueShift}deg)`;
        blurredCtx.drawImage(circleCanvas, (padding / 2), (padding / 2));

        this.blurredCoverArts.set(coverArtUrl, blurredCanvas);
        return blurredCanvas;
    }

    /**
     * Cleans up all resources used by the background
     * This is a fallback cleanup method in case individual Maid cleanups fail
     */
    private cleanup(): void {
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