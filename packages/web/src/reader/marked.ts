/**
 * The one configured `marked` — the reader's blocks and the viewer's markdown tab both load it here.
 *
 * - marked-cjk-friendly: CommonMark closes `**` after punctuation only when a space or punctuation
 *   follows. Korean puts a particle right there (`**"배포 담당"**을`), so the bold stayed as stars;
 *   Chinese and Japanese more often still. The extension treats a CJK neighbour like punctuation and
 *   leaves English as it was (bp: 12 of 260 real agent messages fixed, 248 unchanged). It needs
 *   marked 18 — on 15 and 17 its strikethrough rule throws and any text with `~~` came out unrendered.
 * - Strikethrough only with two tildes. GFM takes one too, so "3~6초 … 5~8초" lost its ranges
 *   to a strike ("36초 … 58초").
 */
type Marked = typeof import('marked')['marked'];

let loading: Promise<Marked> | null = null;

export function loadMarked(): Promise<Marked> {
  return (loading ??= Promise.all([import('marked'), import('marked-cjk-friendly')]).then(([{ marked }, { default: cjkFriendly }]) => {
    marked.use(cjkFriendly());
    marked.use({
      tokenizer: {
        del(src) {
          // The lexer keeps whatever token comes back and the renderer picks by type; Del is only the declared shape.
          if (src[0] === '~' && src[1] !== '~') return { type: 'text', raw: '~', text: '~' } as unknown as ReturnType<NonNullable<import('marked').TokenizerObject['del']>>;
          return false;
        },
      },
    });
    return marked;
  }));
}
