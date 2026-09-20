export type MarkdownNode =
  | string
  | {
      tag: string;
      props: Record<string, string | number | boolean>;
      children: MarkdownNode[];
    };
