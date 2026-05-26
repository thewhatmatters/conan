/**
 * Skills page shell (US-017). A placeholder destination at /skills that US-028
 * fills with the global + project skills browser. Kept minimal here so
 * routing/nav ships independently. Semantic tokens only.
 */
export default function SkillsView() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-lg font-semibold tracking-tight">Skills</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Global and project skills.
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Skills browser arrives in a later story.
      </div>
    </div>
  );
}
