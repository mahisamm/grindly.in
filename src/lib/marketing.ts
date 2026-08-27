export type MarketingResource = {
  slug: string;
  eyebrow: string;
  title: string;
  description: string;
  intro: string;
  sections: { title: string; paragraphs: string[]; points?: string[] }[];
  questions: { question: string; answer: string }[];
};

/**
 * Search pages are deliberately few and substantive. Each answers a question
 * someone can arrive with, then links them to the actual free workflow rather
 * than pretending a static article is a resume tool.
 */
export const MARKETING_RESOURCES: readonly MarketingResource[] = [
  {
    slug: "ats-resume-checker",
    eyebrow: "Resume readiness guide",
    title: "What an ATS resume checker can—and cannot—tell you",
    description: "Learn what applicant tracking systems can read from a resume, what a useful ATS check measures, and how to improve your file without making up experience.",
    intro: "An ATS does not give every resume one secret score. Different employers use different software and job requirements. The useful question is simpler: can the file be read, and does it clearly show the evidence a role asks for?",
    sections: [
      {
        title: "Start with the file, not a promise",
        paragraphs: [
          "A resume can look polished and still fail before a recruiter sees it. Image-only PDFs, text in a table, unusual columns, and contact details hidden behind icons can disappear when software extracts the text layer.",
          "A trustworthy check should show what it found. If it says an email, date, heading or skill is missing, you should be able to see why—not receive an unexplained number designed to make you anxious.",
        ],
        points: ["Use a real text PDF or DOCX.", "Put your name, email, phone and profile URLs in readable text.", "Use familiar section headings and simple bullets.", "Keep the layout single-column when machine readability matters."],
      },
      {
        title: "Match evidence to the role honestly",
        paragraphs: [
          "Keywords help only when they describe work you actually did. Copying a skills list from a job description creates a mismatch between the resume and the interview.",
          "Instead, connect the language of the role to specific projects, responsibilities and outcomes you can explain. If a requirement is missing, name a related transferable example or leave it out.",
        ],
      },
      {
        title: "Use the result to make a better decision",
        paragraphs: [
          "Fix extraction problems first. Then improve clarity: make the role, action, tool and outcome obvious in each important bullet. Finally, tailor the order of real evidence for the job you are applying to.",
          "Grindly measures a published readiness rubric on the text it recovers from your actual file. It does not claim to know an employer's private ATS ranking or promise an interview.",
        ],
      },
    ],
    questions: [
      { question: "What is a good ATS score?", answer: "There is no universal ATS score. A useful result explains its rubric and lets you inspect the text it read. Use it to find file and clarity problems, not as a hiring prediction." },
      { question: "Will a simple resume help with ATS systems?", answer: "Usually. A clear single-column layout with standard headings and readable contact details gives parsers less to misinterpret. Simple does not have to mean plain; it means the important text survives extraction." },
    ],
  },
  {
    slug: "build-a-resume-without-experience",
    eyebrow: "First resume guide",
    title: "How to build a resume when you have little or no work experience",
    description: "A practical, honest way to make a first resume from education, projects, internships, volunteering and skills—without padding it with claims you cannot defend.",
    intro: "A first resume is not an empty work-history template. It is evidence that you can learn, ship work and communicate clearly. The strongest version makes that evidence easy to verify.",
    sections: [
      {
        title: "Choose evidence, not labels",
        paragraphs: [
          "Coursework, personal projects, hackathons, internships, student leadership, volunteering and part-time roles can all be relevant. The title matters less than what you did and what changed because of it.",
          "For each item, write the problem, your action, the tools or methods used, and a concrete result. A result can be a delivered feature, a prototype tested by people, a grade, a time saved or a scope completed—not a made-up percentage.",
        ],
      },
      {
        title: "Give the page a clear order",
        paragraphs: [
          "For students and early-career candidates, education and selected projects often deserve to appear before experience. Put the evidence most relevant to the role near the top.",
          "Keep one page if the content fits. A short, specific resume is more useful than a second page of repeated skills or generic objectives.",
        ],
        points: ["Contact details in text.", "A concise summary only when it adds context.", "Education with relevant coursework when it supports the role.", "Two to four projects with specific bullets.", "Skills grouped by what you can genuinely use."],
      },
      {
        title: "Do not let a generator invent experience",
        paragraphs: [
          "A tool may rephrase and organize your work, but it should never create employers, metrics, dates or technologies you did not provide. Those claims will be tested in an interview.",
          "In Grindly, you can start from scratch, edit freely and build a downloadable resume. The rebuild workflow is designed to strengthen the presentation of your own facts rather than manufacture a background.",
        ],
      },
    ],
    questions: [
      { question: "Should I include school projects on a resume?", answer: "Yes, when they show relevant skills or ownership. Describe the goal, what you built, and the outcome instead of calling every class exercise a major product." },
      { question: "Do I need a summary on my first resume?", answer: "Only if it quickly clarifies the role you are targeting or a useful specialization. Do not use it to repeat generic claims such as hardworking or passionate." },
    ],
  },
  {
    slug: "tailor-your-resume-to-a-job-description",
    eyebrow: "Tailoring guide",
    title: "How to tailor a resume to a job description without keyword stuffing",
    description: "A step-by-step method for tailoring your resume to a role while keeping every claim accurate, readable and defensible in an interview.",
    intro: "Tailoring is not rewriting your history for every application. It is choosing the most relevant true evidence, describing it with the employer's language where it fits, and removing noise.",
    sections: [
      {
        title: "Read for priorities, not every word",
        paragraphs: [
          "Separate the job description into responsibilities, required skills, preferred skills and outcomes. Repeated concepts and the first requirements are usually the strongest signals of what the role needs.",
          "Then map each priority to evidence already in your background. A direct match belongs in a prominent bullet; an adjacent skill may fit in a project or summary; a genuine gap should remain a gap.",
        ],
      },
      {
        title: "Rewrite for proof",
        paragraphs: [
          "A recruiter should not have to infer why a project matters. Lead with the action and include the context: what you built, who or what it served, the tools involved and the observable result.",
          "Do not stuff a paragraph with isolated keywords. Parsers can read them, but a human can see when they are not connected to a real achievement.",
        ],
      },
      {
        title: "Keep a reliable base resume",
        paragraphs: [
          "Keep one primary resume containing your complete, verified history. Create targeted versions from that baseline so you can compare what changed and never lose the original.",
          "Grindly preserves your uploaded or primary resume separately from rebuilt and company-specific versions. Each version has its own label and score, so the document you download is clear.",
        ],
      },
    ],
    questions: [
      { question: "How much should I tailor my resume?", answer: "Tailor the summary, skills order and the bullets most connected to the role. You should not have to replace your entire history for every application." },
      { question: "Can I list a skill I am learning?", answer: "You can say you are learning it if that is accurate, but do not present it as production experience. A resume should set expectations you can support." },
    ],
  },
  {
    slug: "resume-format-for-ats",
    eyebrow: "Formatting guide",
    title: "A resume format that is readable by ATS software and people",
    description: "Use a clean resume format that keeps your information readable when software extracts it and when a recruiter scans it.",
    intro: "The best resume format makes the same information easy for both audiences: a parser extracting text and a person scanning evidence quickly. That usually means fewer decorative layout tricks and clearer hierarchy.",
    sections: [
      {
        title: "Make the text layer do the work",
        paragraphs: [
          "PDF is safe only when the words are real selectable text. Exporting a design as an image can turn your resume into a picture that an applicant tracking system cannot reliably read.",
          "Before applying, select and copy a paragraph from your final PDF into a plain-text editor. If the order, contact information or bullets become mangled, repair the source layout and export again.",
        ],
      },
      {
        title: "Use a predictable structure",
        paragraphs: [
          "Put your name and contact details at the top, then use standard headings such as Experience, Education, Projects and Skills. Keep dates and locations beside the relevant entry rather than in a detached design element.",
          "Use simple bullets and one main column. Tables, sidebars and icon-only links can work in some systems but introduce needless parsing risk when your goal is broad compatibility.",
        ],
      },
      {
        title: "Design still matters",
        paragraphs: [
          "ATS-friendly does not mean ugly. A strong name header, deliberate type scale, spacing and clean divider lines create a professional page without hiding the data software needs.",
          "Grindly renders its rebuilt resumes from structured content so the visual layout and text extraction are checked together. You should still review the final PDF before sending it.",
        ],
      },
    ],
    questions: [
      { question: "Should I use a two-column resume?", answer: "For broad ATS compatibility, a single-column resume is safer. A two-column layout may parse correctly in some systems, but it creates more ways for reading order and headings to break." },
      { question: "Can I use icons for email and LinkedIn?", answer: "Use icons only alongside the actual email address and URL. Icon-only contact details may look clean but can disappear from extracted text." },
    ],
  },
] as const;

export function marketingResource(slug: string) {
  return MARKETING_RESOURCES.find((resource) => resource.slug === slug);
}
