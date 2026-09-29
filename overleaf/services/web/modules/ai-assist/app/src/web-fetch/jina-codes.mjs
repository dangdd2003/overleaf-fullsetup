/**
 * The codes Jina's Search API accepts for `gl` and `hl`, from WORLD_COUNTRIES
 * and WORLD_LANGUAGES in jina-ai/reader (src/3rd-party/serper-search.ts). Any
 * other value is refused with a 400, so a setting outside these is dropped.
 * Countries match in any case; languages must match exactly, as in sr-ME.
 */

const COUNTRIES = `
  ad ae af ag ai al am an ao aq ar as at au aw ax az ba bb bd be bf bg bh bi
  bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu
  cv cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga
  gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id
  ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la
  lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms
  mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph
  pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk
  sl sm sn so sr st sv sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz
  ua ug um us uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw
`

const LANGUAGES = `
  af ak sq am ar hy az eu be bem bn bh bs br bg km ca chr ny zh-cn zh-tw co
  hr cs da nl en eo et ee fo tl fi fr fy gaa gl ka de el gn gu ht ha haw iw
  hi hu is ig id ia ga it ja jw kn kk rw rn kg ko kri ku ckb ky lo la lv ln
  lt loz lg ach mk mg ms ml mt mi mr mfe mo mn sr-ME ne pcm nso no nn oc or
  om ps fa pl pt pt-br pt-pt pa qu ro rm nyn ru gd sr sh st tn crs sn sd si
  sk sl so es es-419 su sw sv tg ta tt te th ti to lua tum tr tk tw ug uk ur
  uz vi cy wo xh yi yo zu
`

export const JINA_COUNTRIES = new Set(COUNTRIES.trim().split(/\s+/))

/** Lowercased code to the spelling Jina expects. */
export const JINA_LANGUAGES = new Map(
  LANGUAGES.trim()
    .split(/\s+/)
    .map(code => [code.toLowerCase(), code])
)
