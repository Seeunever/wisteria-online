import type { ProjectedContent } from '@/lib/blind-runtime';

export function ProtectedContent({
  code,
  content,
}: {
  code: string;
  content: ProjectedContent;
}) {
  if (content.kind === 'text') return <p>{content.text}</p>;
  return Array.from({ length: content.parts }, (_, part) => (
    // The protected route re-derives current room authorization on every request.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="protected-scan"
      key={`${content.contentId}-${part}`}
      src={`/api/rooms/${code}/content/${content.contentId}?part=${part}`}
      alt="已授权的剧本内容"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  ));
}
