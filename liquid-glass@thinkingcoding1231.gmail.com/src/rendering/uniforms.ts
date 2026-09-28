import type Cogl from 'gi://Cogl';

export class UniformState {
  private _pipeline: Cogl.Pipeline | null = null;

  get values(): ReadonlyMap<string, number> { return this._pendingUniforms; }

  attach(pipeline: Cogl.Pipeline | null): void {
    this._pipeline = pipeline;
    this._compUniforms.clear();
    this._compUniformArrays.clear();
    this._appliedUniforms.clear();
    this._appliedUniformArrays.clear();
    if (pipeline) this.flush();
  }

  takeDirty(): boolean {
    const changed = this._uniformsDirty;
    this._uniformsDirty = false;
    return changed;
  }

  clear(): void {
    this.attach(null);
    this._pendingUniforms.clear();
    this._pendingUniformArrays.clear();
    this._uniformsDirty = false;
  }

  private _compUniforms: Map<string, number> = new Map();

  private _pendingUniforms: Map<string, number> = new Map();

  private _compUniformArrays: Map<string, number> = new Map();

  private _pendingUniformArrays: Map<string, number[]> = new Map();

  private _appliedUniforms: Map<string, number> = new Map();

  private _appliedUniformArrays: Map<string, number[]> = new Map();

  private _uniformsDirty: boolean = false;

  private _uniformScratch: number[] = [0];

  set(name: string, value: number): void {
    if (this._pendingUniforms.get(name) === value) return;

    this._pendingUniforms.set(name, value);
    this._uniformsDirty = true;
    if (this._pipeline) {
      this._applyUniform(name, value);
    }
  }

  private _applyUniform(name: string, value: number): void {
    if (!this._pipeline) return;

    if (this._appliedUniforms.get(name) === value) return;

    let loc = this._compUniforms.get(name);
    if (loc === undefined) {
      loc = this._pipeline.get_uniform_location(name);
      this._compUniforms.set(name, loc);
    }
    this._uniformScratch[0] = value;
    this._pipeline.set_uniform_float(loc, 1, 1, this._uniformScratch);
    this._appliedUniforms.set(name, value);
  }

  flush(): void {
    for (const [name, value] of this._pendingUniforms) {
      this._applyUniform(name, value);
    }
    for (const [name, values] of this._pendingUniformArrays) {
      this._applyUniformArray(name, values);
    }
  }

  setArray(name: string, values: number[]): void {
    const prev = this._pendingUniformArrays.get(name);
    if (prev && prev.length === values.length) {
      let same = true;
      for (let i = 0; i < values.length; i++) {
        if (prev[i] !== values[i]) { same = false; break; }
      }
      if (same) return;
    }

    this._pendingUniformArrays.set(name, values.slice());
    this._uniformsDirty = true;
    if (this._pipeline) {
      this._applyUniformArray(name, values);
    }
  }

  private _applyUniformArray(name: string, values: number[]): void {
    if (!this._pipeline) return;

    const applied = this._appliedUniformArrays.get(name);
    if (applied && applied.length === values.length) {
      let same = true;
      for (let i = 0; i < values.length; i++) {
        if (applied[i] !== values[i]) { same = false; break; }
      }
      if (same) return;
    }

    let loc = this._compUniformArrays.get(name);
    if (loc === undefined) {
      loc = this._pipeline.get_uniform_location(name);
      this._compUniformArrays.set(name, loc);
    }
    this._pipeline.set_uniform_float(loc, 1, values.length, values);
    this._appliedUniformArrays.set(name, values.slice());
  }
}
