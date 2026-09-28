import Cogl from 'gi://Cogl';
import { configureSamplerLayer } from './pipelines.js';
import { setPipelineFloat, setPipelineVec2 } from './passes.js';
import { computeGaussianKernel, buildGaussianSnippet } from './shaderSource.js';
export class BlurRenderer {
    _pipelines;
    _passes;
    _repaint;
    _logger;
    constructor(_pipelines, _passes, _repaint, _logger) {
        this._pipelines = _pipelines;
        this._passes = _passes;
        this._repaint = _repaint;
        this._logger = _logger;
    }
    get radius() { return this._targetRadius; }
    get downscale() { return this._blurDownscale; }
    get passCount() { return this.PASS_COUNT; }
    get result() { return this._blurResultTex; }
    get width() { return this._poolWidth; }
    get height() { return this._poolHeight; }
    get ready() { return this.PASS_COUNT === 0 || this._blurFbos.length > 0; }
    get needsCompile() { return this._gaussianPipelineDirty && this._pendingGaussianKernel !== null; }
    invalidate() { this._destroyTexturePool(); }
    compilePending(ctx) {
        if (!this.needsCompile)
            return;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compileGaussianPipelines(ctx, this._pendingGaussianKernel);
    }
    render(parent, source, uv, inputKey) {
        this._blurResultTex = null;
        this._renderedKey = null;
        if (this.PASS_COUNT <= 0)
            return;
        if (this._blurMethod === 0) {
            if (this._gaussianHPipeline && this._gaussianVPipeline)
                this._runGaussianBlur(parent, source, uv);
        }
        else
            this._runDualKawaseBlur(parent, source, uv);
        if (inputKey && this._blurResultTex !== null)
            this._renderedKey = [...inputKey, ...this._configKey()];
    }
    canReuse(inputKey) {
        const stored = this._renderedKey;
        if (stored === null || this._blurResultTex === null || this.PASS_COUNT <= 0)
            return false;
        const config = this._configKey();
        if (stored.length !== inputKey.length + config.length)
            return false;
        for (let i = 0; i < inputKey.length; i++)
            if (stored[i] !== inputKey[i])
                return false;
        for (let i = 0; i < config.length; i++)
            if (stored[inputKey.length + i] !== config[i])
                return false;
        return true;
    }
    _renderedKey = null;
    _configKey() {
        const p = this._pipelines;
        return [this._blurFbos[0] ?? null, this._blurMethod, this.PASS_COUNT, this._blurDownscale,
            this._blurRadiusDown, this._blurRadiusUp, this._gaussianScale,
            this._gaussianHPipeline, this._gaussianVPipeline,
            p.downsample, p.upsample, p.passthrough, p.boxDown];
    }
    setDownscale(factor) {
        if (factor === this._blurDownscale)
            return;
        this._blurDownscale = factor;
        this._destroyTexturePool();
        this.setBlurRadius(this._targetRadius);
        this._repaint();
    }
    reload() {
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._gaussianKernel = null;
        this._gaussianFetchPairs = 0;
        this.setBlurRadius(this._targetRadius);
    }
    clear() {
        this._destroyTexturePool();
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._gaussianKernel = null;
        this._pendingGaussianKernel = null;
        this._gaussianPipelineDirty = false;
        this._gaussianBaseSigma = 0;
        this._gaussianScale = 1;
        this._gaussianFetchPairs = 0;
    }
    describe() {
        const result = this._blurResultTex;
        return {
            blurMethod: this._blurMethod, passCount: this.PASS_COUNT,
            pool: this._poolWidth + 'x' + this._poolHeight, poolLevels: this._blurFbos.length,
            blurResult: result ? result.get_width() + 'x' + result.get_height() : 'NULL (layer 1 falls back to the SHARP capture)',
            radiusDown: this._blurRadiusDown, radiusUp: this._blurRadiusUp, targetRadius: this._targetRadius,
            gaussianPipelines: !!(this._gaussianHPipeline && this._gaussianVPipeline),
        };
    }
    _blurTextures = [];
    _blurFbos = [];
    _gaussianTempTextures = [];
    _gaussianTempFbos = [];
    _upTextures = [];
    _upFbos = [];
    _blurResultTex = null;
    _gaussianHPipeline = null;
    _gaussianVPipeline = null;
    _blurMethod = 1;
    _gaussianKernel = null;
    _pendingGaussianKernel = null;
    _gaussianPipelineDirty = false;
    _gaussianBaseSigma = 0;
    _gaussianScale = 1.0;
    _gaussianFetchPairs = 0;
    _poolWidth = 0;
    _poolHeight = 0;
    _blurDownscale = 2;
    PASS_COUNT = 4;
    _blurRadiusDown = 0.5;
    _blurRadiusUp = 1.0;
    _targetRadius = 15.0;
    _compileGaussianPipelines(ctx, kernel) {
        this._gaussianHPipeline = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this._gaussianHPipeline, 0);
        const hSnippet = buildGaussianSnippet(kernel, 'h');
        const hSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, hSnippet.decl, null);
        hSnip.set_replace(hSnippet.body);
        this._gaussianHPipeline.add_snippet(hSnip);
        this._gaussianVPipeline = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this._gaussianVPipeline, 0);
        const vSnippet = buildGaussianSnippet(kernel, 'v');
        const vSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, vSnippet.decl, null);
        vSnip.set_replace(vSnippet.body);
        this._gaussianVPipeline.add_snippet(vSnip);
        this._gaussianKernel = kernel;
        this._gaussianPipelineDirty = false;
        this._pendingGaussianKernel = null;
    }
    resize(ctx, w, h) {
        this._destroyTexturePool();
        const shift = this._blurDownscale >= 4 ? 2 : 1;
        let pw = Math.max(w >> shift, 1);
        let ph = Math.max(h >> shift, 1);
        for (let i = 0; i < this.PASS_COUNT; i++) {
            try {
                const tex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
                const fbo = Cogl.Offscreen.new_with_texture(tex);
                this._blurTextures.push(tex);
                this._blurFbos.push(fbo);
                const tmpTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
                const tmpFbo = Cogl.Offscreen.new_with_texture(tmpTex);
                this._gaussianTempTextures.push(tmpTex);
                this._gaussianTempFbos.push(tmpFbo);
                const upTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
                const upFbo = Cogl.Offscreen.new_with_texture(upTex);
                this._upTextures.push(upTex);
                this._upFbos.push(upFbo);
            }
            catch (e) {
                this._logger?.error(`[Liquid Glass] Failed to build texture pool at pass ${i} (${pw}x${ph}): ${e}`);
                this._destroyTexturePool();
                return;
            }
            pw = Math.max(pw >> 1, 1);
            ph = Math.max(ph >> 1, 1);
        }
        this._poolWidth = w;
        this._poolHeight = h;
    }
    _runDualKawaseBlur(parentNode, srcTex, srcUV) {
        let currentSrc = srcTex;
        for (let i = 0; i < this.PASS_COUNT; i++) {
            const destFbo = this._blurFbos[i];
            const destTex = this._blurTextures[i];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / currentSrc.get_width();
            const invH = 1.0 / currentSrc.get_height();
            const uv = (i === 0) ? srcUV : [0, 0, 1, 1];
            const boxFirst = i === 0 && this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
            const pipeline = boxFirst
                ? this._passes.pipeline('kawase-down-0-box', this._pipelines.boxDown)
                : this._passes.pipeline(`kawase-down-${i}`, this._pipelines.downsample);
            pipeline.set_layer_texture(0, currentSrc);
            setPipelineVec2(pipeline, 'inv_size', invW, invH);
            if (!boxFirst)
                setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusDown);
            this._passes.add(parentNode, destFbo, pipeline, destW, destH, uv);
            currentSrc = destTex;
        }
        if (this.PASS_COUNT <= 1) {
            this._blurResultTex = this._blurTextures[0];
            return;
        }
        for (let i = this.PASS_COUNT - 1; i > 0; i--) {
            const srcTexture = (i === this.PASS_COUNT - 1)
                ? this._blurTextures[i]
                : this._upTextures[i];
            const destFbo = this._upFbos[i - 1];
            const destTex = this._upTextures[i - 1];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / srcTexture.get_width();
            const invH = 1.0 / srcTexture.get_height();
            const pipeline = this._passes.pipeline(`kawase-up-${i}`, this._pipelines.upsample);
            pipeline.set_layer_texture(0, srcTexture);
            setPipelineVec2(pipeline, 'inv_size', invW, invH);
            setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusUp);
            this._passes.add(parentNode, destFbo, pipeline, destW, destH, [0, 0, 1, 1]);
        }
        this._blurResultTex = this._upTextures[0];
    }
    _runGaussianBlur(parentNode, srcTex, srcUV) {
        const tempFbo = this._gaussianTempFbos[0];
        const tempTex = this._gaussianTempTextures[0];
        const destFbo = this._blurFbos[0];
        const destTex = this._blurTextures[0];
        const destW = destTex.get_width();
        const destH = destTex.get_height();
        const wideDownsample = this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
        const prePipeline = wideDownsample
            ? this._passes.pipeline('gauss-pre-box', this._pipelines.boxDown)
            : this._passes.pipeline('gauss-pre', this._pipelines.passthrough);
        prePipeline.set_layer_texture(0, srcTex);
        if (wideDownsample) {
            setPipelineVec2(prePipeline, 'inv_size', 1.0 / srcTex.get_width(), 1.0 / srcTex.get_height());
        }
        this._passes.add(parentNode, destFbo, prePipeline, destW, destH, srcUV);
        const hPipeline = this._passes.pipeline('gauss-h', this._gaussianHPipeline);
        hPipeline.set_layer_texture(0, destTex);
        setPipelineVec2(hPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        setPipelineFloat(hPipeline, 'kernel_scale', this._gaussianScale);
        this._passes.add(parentNode, tempFbo, hPipeline, destW, destH, [0, 0, 1, 1]);
        const vPipeline = this._passes.pipeline('gauss-v', this._gaussianVPipeline);
        vPipeline.set_layer_texture(0, tempTex);
        setPipelineVec2(vPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        setPipelineFloat(vPipeline, 'kernel_scale', this._gaussianScale);
        const outFbo = this._upFbos[0];
        this._passes.add(parentNode, outFbo, vPipeline, destW, destH, [0, 0, 1, 1]);
        this._blurResultTex = this._upTextures[0];
    }
    _destroyTexturePool() {
        this._blurFbos = [];
        this._blurTextures = [];
        this._gaussianTempFbos = [];
        this._gaussianTempTextures = [];
        this._upFbos = [];
        this._upTextures = [];
        this._blurResultTex = null;
        this._renderedKey = null;
        this._poolWidth = 0;
        this._poolHeight = 0;
    }
    setBlurMethod(method) {
        if (this._blurMethod === method)
            return;
        this._blurMethod = method;
        this.setBlurRadius(this._targetRadius);
        this._repaint();
    }
    setBlurRadius(radius) {
        this._targetRadius = radius;
        if (this._blurMethod === 0) {
            this._setGaussianBlurRadius(radius);
            return;
        }
        this._setDualKawaseBlurRadius(radius);
    }
    _setGaussianBlurRadius(radius) {
        const RES_SCALE = this._blurDownscale >= 4 ? 4.0 : 2.0;
        const MAX_SIGMA_TEXEL = 15.0;
        const MIN_SIGMA_TEXEL = 1.0;
        if (radius <= 0) {
            if (this.PASS_COUNT !== 0) {
                this.PASS_COUNT = 0;
                this._destroyTexturePool();
            }
            this._gaussianScale = 0.0;
            this._repaint();
            return;
        }
        const sigmaTexel = Math.min(radius / RES_SCALE, MAX_SIGMA_TEXEL);
        const kernelSigma = Math.max(sigmaTexel, MIN_SIGMA_TEXEL);
        const sideTaps = Math.max(2, Math.ceil(kernelSigma * 4));
        const fetchPairs = Math.max(2, Math.ceil(sideTaps / 2));
        const needsRecompile = this._gaussianFetchPairs !== fetchPairs ||
            (!this._gaussianKernel && !this._pendingGaussianKernel);
        if (needsRecompile) {
            const kernel = computeGaussianKernel(kernelSigma, fetchPairs);
            this._pendingGaussianKernel = kernel;
            this._gaussianPipelineDirty = true;
            this._gaussianFetchPairs = fetchPairs;
            this._gaussianBaseSigma = kernelSigma;
            this._gaussianScale = sigmaTexel / kernelSigma;
        }
        else {
            this._gaussianScale = this._gaussianBaseSigma > 0
                ? sigmaTexel / this._gaussianBaseSigma
                : 1.0;
        }
        if (this.PASS_COUNT !== 1) {
            this.PASS_COUNT = 1;
            this._destroyTexturePool();
        }
        this._repaint();
    }
    _setDualKawaseBlurRadius(radius) {
        let newPassCount = 0;
        let offsetDown = 0.0;
        let offsetUp = 0.0;
        if (radius > 0) {
            let p = Math.floor(Math.log2(radius + 1));
            newPassCount = Math.max(1, Math.min(4, p));
            let baseR = (newPassCount === 1) ? 0 : Math.pow(2, newPassCount) - 1;
            let nextR = Math.pow(2, newPassCount + 1) - 1;
            let t = (radius - baseR) / (nextR - baseR);
            t = Math.max(0.0, Math.min(1.0, t));
            let s = 0.25 * Math.pow(t, 3) - 0.75 * Math.pow(t, 2) + 1.5 * t;
            let minOffset = (newPassCount === 1) ? 0.0 : 0.5;
            let maxOffset = 1.0;
            let r = minOffset + s * (maxOffset - minOffset);
            offsetDown = r;
            offsetUp = r * 1.5;
        }
        if (this.PASS_COUNT !== newPassCount ||
            this._blurRadiusDown !== offsetDown ||
            this._blurRadiusUp !== offsetUp) {
            const passCountChanged = this.PASS_COUNT !== newPassCount;
            this.PASS_COUNT = newPassCount;
            this._blurRadiusDown = offsetDown;
            this._blurRadiusUp = offsetUp;
            if (passCountChanged) {
                this._destroyTexturePool();
            }
            this._repaint();
        }
    }
}
