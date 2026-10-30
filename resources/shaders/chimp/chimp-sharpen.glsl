// Chimpanzé Player — nitidez adaptativa (baseada no AMD FidelityFX CAS, licença MIT).
// chimp_sharpness: 0 = desligado, 1 = forte, até 2 = muito forte.

//!PARAM chimp_sharpness
//!DESC Nitidez
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 2.0
0.5

//!HOOK SCALED
//!BIND HOOKED
//!DESC Chimpanze nitidez (CAS)

vec4 hook() {
    vec3 a = HOOKED_texOff(vec2(-1.0, -1.0)).rgb;
    vec3 b = HOOKED_texOff(vec2( 0.0, -1.0)).rgb;
    vec3 c = HOOKED_texOff(vec2( 1.0, -1.0)).rgb;
    vec3 d = HOOKED_texOff(vec2(-1.0,  0.0)).rgb;
    vec4 eFull = HOOKED_texOff(vec2(0.0, 0.0));
    vec3 e = eFull.rgb;
    vec3 f = HOOKED_texOff(vec2( 1.0,  0.0)).rgb;
    vec3 g = HOOKED_texOff(vec2(-1.0,  1.0)).rgb;
    vec3 h = HOOKED_texOff(vec2( 0.0,  1.0)).rgb;
    vec3 i = HOOKED_texOff(vec2( 1.0,  1.0)).rgb;

    vec3 mnRGB = min(min(min(d, e), min(f, b)), h);
    vec3 mnRGB2 = min(mnRGB, min(min(a, c), min(g, i)));
    mnRGB += mnRGB2;
    vec3 mxRGB = max(max(max(d, e), max(f, b)), h);
    vec3 mxRGB2 = max(mxRGB, max(max(a, c), max(g, i)));
    mxRGB += mxRGB2;

    vec3 rcpMRGB = 1.0 / max(mxRGB, vec3(1e-5));
    vec3 ampRGB = clamp(min(mnRGB, 2.0 - mxRGB) * rcpMRGB, 0.0, 1.0);
    ampRGB = sqrt(ampRGB);

    float s = clamp(chimp_sharpness, 0.0, 1.0);
    float peak = -1.0 / mix(8.0, 5.0, s);
    vec3 wRGB = ampRGB * peak;
    vec3 rcpWeightRGB = 1.0 / (1.0 + 4.0 * wRGB);
    vec3 window = b + d + f + h;
    vec3 outColor = clamp((window * wRGB + e) * rcpWeightRGB, 0.0, 1.0);

    // Acima de 1.0 amplifica o efeito.
    float boost = 1.0 + max(chimp_sharpness - 1.0, 0.0) * 1.5;
    outColor = e + (outColor - e) * boost;

    return vec4(clamp(outColor, 0.0, max(1.0, max(e.r, max(e.g, e.b)))), eFull.a);
}
