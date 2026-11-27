export const Platform = {
  OS: 'ios' as const,
  select: <T>(o: { ios?: T; default?: T }): T | undefined => o.ios ?? o.default
}
