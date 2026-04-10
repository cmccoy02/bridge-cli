import boxen from 'boxen';

export function printSummary(lines, title = 'Bridge') {
  const content = lines.join('\n');
  const summary = boxen(content, {
    title,
    titleAlignment: 'left',
    borderColor: 'cyan',
    padding: 1,
    margin: { top: 1, bottom: 0, left: 0, right: 0 }
  });

  console.log(summary);
}
