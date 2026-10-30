# Chimpanze Player - ferramenta do motor RTX (TensorRT completo via vs-mlrt, mesmo caminho do SVP).
# Uso:
#   python rtx_tool.py check <dir>
#   python rtx_tool.py build <dir> <modelo>
# A última linha impressa em stdout é sempre um JSON com o resultado.
import json
import os
import sys
import time
import traceback


def emit(obj):
    sys.stdout.write("\n" + json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    cmd = sys.argv[1]
    base = sys.argv[2]
    import vapoursynth as vs
    core = vs.core
    if not hasattr(core, "trt"):
        core.std.LoadPlugin(path=os.path.join(base, "vstrt.dll"))
    ver = core.trt.Version()
    info = {"tensorrt_version": int(ver.get("tensorrt_version", 0))}
    try:
        dev = core.trt.DeviceProperties(0)
        name = dev["name"]
        info["device"] = name.decode() if isinstance(name, bytes) else str(name)
    except Exception as e:
        info["device_error"] = str(e)
    if cmd == "check":
        emit({"ok": True, **info})
        return

    model_name = sys.argv[3]
    if base not in sys.path:
        sys.path.insert(0, base)
    import vsmlrt
    from fractions import Fraction

    backend = vsmlrt.Backend.TRT(
        fp16=True, output_format=1, device_id=0, num_streams=3, use_cuda_graph=True,
        static_shape=False, min_shapes=(64, 64), opt_shapes=(1920, 1080), max_shapes=(1920, 1088),
        engine_folder=os.path.join(base, "engines"),
    )
    model = getattr(vsmlrt.RIFEModel, model_name)

    t0 = time.time()
    results = {}
    for (w, h) in ((1920, 1080), (1280, 720)):
        n = 120
        src = core.std.BlankClip(width=w, height=h, format=vs.RGBH, length=n + 8, fpsnum=24000, fpsden=1001)
        # quadros diferentes para a IA trabalhar de verdade
        src = core.std.FrameEval(src, lambda n, c=src: c.std.BlankClip(color=[((n * 7) % 100) / 100.0, 0.3, 0.2]))
        out = vsmlrt.RIFE(src, multi=Fraction(5, 2), model=model, backend=backend, video_player=True, _implementation=2)
        out.get_frame(1)  # constrói/carrega o motor
        out = out[2:2 + n]
        t = time.time()
        # Pede vários quadros em paralelo, como o player faz.
        for _ in out.frames(prefetch=8, backlog=16):
            pass
        dt = time.time() - t
        results[f"{w}x{h}"] = round(n / dt, 1) if dt > 0 else 0
    emit({"ok": True, "model": model_name, "fp16": True, "build_seconds": round(time.time() - t0, 1), "fps": results, **info})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"ok": False, "error": str(e), "trace": traceback.format_exc()[-2000:]})
        sys.exit(1)
