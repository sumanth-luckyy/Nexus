/**
 * Nexus Silk Background
 * Vanilla JS + Three.js implementation of Silk animated shader background
 */

class SilkBackground {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) {
      console.warn(`SilkBackground: Canvas #${canvasId} not found.`);
      return;
    }

    this.options = Object.assign({
      speed: 2.5,
      scale: 1.0,
      color: '#00D9FF',
      noiseIntensity: 0.8,
      rotation: 0.0
    }, options);

    this.animationFrameId = null;
    this.clock = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.material = null;

    this.init();
  }

  init() {
    if (typeof THREE === 'undefined') {
      console.error('SilkBackground: Three.js library is not loaded.');
      return;
    }

    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // 2. Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // 3. Shaders
    const vertexShader = `
      varying vec2 vUv;
      varying vec3 vPosition;

      void main() {
        vPosition = position;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      varying vec2 vUv;
      varying vec3 vPosition;

      uniform float uTime;
      uniform vec3 uColor;
      uniform float uSpeed;
      uniform float uScale;
      uniform float uRotation;
      uniform float uNoiseIntensity;

      const float e = 2.71828182845904523536;

      float noise(vec2 texCoord) {
        float G = e;
        vec2 r = (G * sin(G * texCoord));
        return fract(r.x * r.y * (1.0 + texCoord.x));
      }

      vec2 rotateUvs(vec2 uv, float angle) {
        float c = cos(angle);
        float s = sin(angle);
        mat2 rot = mat2(c, -s, s, c);
        return rot * uv;
      }

      void main() {
        float rnd = noise(gl_FragCoord.xy);

        vec2 uv = rotateUvs(vUv * uScale, uRotation);
        vec2 tex = uv * uScale;

        float tOffset = uSpeed * uTime;

        tex.y += 0.03 * sin(8.0 * tex.x - tOffset);

        float pattern =
            0.6 +
            0.4 * sin(
              5.0 * (
                tex.x +
                tex.y +
                cos(3.0 * tex.x + 5.0 * tex.y) +
                0.02 * tOffset
              ) +
              sin(20.0 * (tex.x + tex.y - 0.1 * tOffset))
            );

        vec4 col =
            vec4(uColor, 1.0) * vec4(pattern)
            - rnd / 15.0 * uNoiseIntensity;

        col.a = 1.0;

        gl_FragColor = col;
      }
    `;

    // Initial color conversion
    const threeColor = new THREE.Color(this.options.color);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: threeColor },
        uSpeed: { value: this.options.speed },
        uScale: { value: this.options.scale },
        uRotation: { value: this.options.rotation },
        uNoiseIntensity: { value: this.options.noiseIntensity }
      },
      depthWrite: false,
      depthTest: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, this.material);
    this.scene.add(mesh);

    this.clock = new THREE.Clock();

    // Event listeners
    this.onResize = this.onResize.bind(this);
    this.onVisibilityChange = this.onVisibilityChange.bind(this);

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.animate();
  }

  animate() {
    if (document.hidden) return;

    this.animationFrameId = requestAnimationFrame(() => this.animate());

    const elapsedTime = this.clock.getElapsedTime();
    this.material.uniforms.uTime.value = elapsedTime;

    this.renderer.render(this.scene, this.camera);
  }

  onResize() {
    if (!this.renderer) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  onVisibilityChange() {
    if (document.hidden) {
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    } else {
      if (!this.animationFrameId) {
        this.animate();
      }
    }
  }

  setColor(hexColor) {
    if (this.material && this.material.uniforms.uColor) {
      this.material.uniforms.uColor.value.set(hexColor);
    }
  }

  destroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    if (this.renderer) {
      this.renderer.dispose();
    }
    if (this.material) {
      this.material.dispose();
    }
  }
}

// Global initialization helper
window.SilkBackground = SilkBackground;
