// Chimpanzé Player — ajustes de cor em tempo real (exposição, temperatura, tonalidade, vibrância).
// Parâmetros alterados ao vivo via glsl-shader-opts.

//!PARAM chimp_exposure
//!DESC Exposição (EV)
//!TYPE float
//!MINIMUM -3.0
//!MAXIMUM 3.0
0.0

//!PARAM chimp_temperature
//!DESC Temperatura (frio/quente)
//!TYPE float
//!MINIMUM -1.0
//!MAXIMUM 1.0
0.0

//!PARAM chimp_tint
//!DESC Tonalidade (verde/magenta)
//!TYPE float
//!MINIMUM -1.0
//!MAXIMUM 1.0
0.0

//!PARAM chimp_vibrance
//!DESC Vibrância
//!TYPE float
//!MINIMUM -1.0
//!MAXIMUM 1.0
0.0

//!HOOK MAIN
//!BIND HOOKED
//!DESC Chimpanze cor

vec4 hook() {
    vec4 color = HOOKED_texOff(0);
    vec3 c = max(color.rgb, vec3(0.0));

    // Exposição em espaço aproximadamente linear.
    vec3 lin = pow(c, vec3(2.2));
    lin *= exp2(chimp_exposure);

    // Balanço de branco simples.
    vec3 wb = vec3(1.0 + 0.12 * chimp_temperature, 1.0 - 0.10 * chimp_tint, 1.0 - 0.12 * chimp_temperature);
    wb.rb *= 1.0 + 0.05 * chimp_tint;
    lin *= wb;

    c = pow(max(lin, vec3(0.0)), vec3(1.0 / 2.2));

    // Vibrância: satura mais as cores pouco saturadas.
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    float amount = 1.0 + chimp_vibrance * (1.0 - sat) * 1.2;
    c = mix(vec3(luma), c, amount);

    color.rgb = c;
    return color;
}
